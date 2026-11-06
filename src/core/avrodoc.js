'use strict';
// Avro object container file (.avro) reader with random access to blocks.
// A header pass reads only the block headers (row count and byte size) and skips the data.
// A block is read and decoded when its rows are needed.

const zlib = require('zlib');
const avro = require('avsc');
const snappy = require('snappyjs');
const zstd = require('fzstd');
const L = require('./limits');
const V = require('./values');
const { ReadError, fmtGB } = require('./arrowdoc');

const MAGIC = Buffer.from([0x4f, 0x62, 0x6a, 0x01]); // Obj\x01
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);

// Longs outside the safe integer range become strings instead of throwing.
const SafeLong = avro.types.LongType.__with({
  fromBuffer: buf => { const v = buf.readBigInt64LE(0); return v <= MAX_SAFE && v >= -MAX_SAFE ? Number(v) : v.toString(); },
  toBuffer: n => { const b = Buffer.alloc(8); b.writeBigInt64LE(BigInt(n)); return b; },
  fromJSON: x => x,
  toJSON: x => x,
  isValid: x => typeof x === 'number' || typeof x === 'string',
  compare: (a, b) => (BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0),
});

const PRIMS = new Set(['null', 'boolean', 'int', 'long', 'float', 'double', 'bytes', 'string']);
/**
 * Copy of the schema for decoding: {type: 'long', logicalType: ...} becomes 'long' so the safe long type
 * from the registry is used (avsc builds a plain long for object schemas). Logical types are applied
 * later from the original schema.
 */
function decodingSchema(s) {
  if (Array.isArray(s)) return s.map(decodingSchema);
  if (!s || typeof s !== 'object') return s;
  if (typeof s.type === 'string' && PRIMS.has(s.type)) return s.type;
  const o = { ...s };
  if (o.fields) o.fields = o.fields.map(f => ({ ...f, type: decodingSchema(f.type) }));
  if (o.items !== undefined) o.items = decodingSchema(o.items);
  if (o.values !== undefined) o.values = decodingSchema(o.values);
  if (typeof o.type === 'object') o.type = decodingSchema(o.type);
  return o;
}

/** Reads zig-zag varint longs from a buffer. */
function readLong(buf, pos) {
  let n = 0n, shift = 0n, b, p = pos;
  do {
    if (p >= buf.length) return null;
    b = buf[p++];
    n |= BigInt(b & 0x7f) << shift;
    shift += 7n;
    if (shift > 70n) throw new ReadError('Bad number in the Avro file header.', 'BAD');
  } while (b & 0x80);
  const v = (n >> 1n) ^ -(n & 1n);
  return { value: Number(v), pos: p };
}

/** Parse the file header from buf. Returns null if buf is too short. */
function parseHeader(buf) {
  if (buf.length < 4) return null;
  if (!buf.subarray(0, 4).equals(MAGIC)) throw new ReadError('This is not an Avro object container file (no "Obj" header). Plain Avro records without a container header cannot be read without their schema.', 'BAD');
  let pos = 4;
  const meta = {};
  for (;;) {
    const c = readLong(buf, pos);
    if (!c) return null;
    pos = c.pos;
    let count = c.value;
    if (count === 0) break;
    if (count < 0) { count = -count; const sz = readLong(buf, pos); if (!sz) return null; pos = sz.pos; }
    for (let i = 0; i < count; i++) {
      const kl = readLong(buf, pos); if (!kl) return null;
      if (kl.pos + kl.value > buf.length) return null;
      const key = buf.subarray(kl.pos, kl.pos + kl.value).toString('utf8');
      pos = kl.pos + kl.value;
      const vl = readLong(buf, pos); if (!vl) return null;
      if (vl.pos + vl.value > buf.length) return null;
      meta[key] = buf.subarray(vl.pos, vl.pos + vl.value);
      pos = vl.pos + vl.value;
    }
  }
  if (pos + 16 > buf.length) return null;
  return { meta, sync: Buffer.from(buf.subarray(pos, pos + 16)), end: pos + 16 };
}

const CODECS = {
  null: b => b,
  deflate: b => zlib.inflateRawSync(b),
  snappy: b => Buffer.from(snappy.uncompress(b.subarray(0, b.length - 4))), // last 4 bytes are a CRC32
  zstandard: b => Buffer.from(zstd.decompress(b)),
};

/** Short type text, e.g. "string?", "array<long>", "timestamp-millis", "decimal(10,2)". */
function avroTypeName(s) {
  if (typeof s === 'string') return s;
  if (Array.isArray(s)) {
    const rest = s.filter(x => x !== 'null' && !(x && x.type === 'null'));
    const nullable = rest.length < s.length;
    const inner = rest.length === 1 ? avroTypeName(rest[0]) : `union<${rest.map(avroTypeName).join(', ')}>`;
    return inner + (nullable ? '?' : '');
  }
  if (!s || typeof s !== 'object') return String(s);
  if (s.logicalType === 'decimal') return `decimal(${s.precision},${s.scale || 0})`;
  if (s.logicalType) return s.logicalType;
  switch (s.type) {
    case 'record': case 'error': return `record ${s.name || ''}`.trim();
    case 'enum': return `enum ${s.name || ''}`.trim();
    case 'fixed': return `fixed(${s.size})`;
    case 'array': return `array<${avroTypeName(s.items)}>`;
    case 'map': return `map<${avroTypeName(s.values)}>`;
    default: return avroTypeName(s.type);
  }
}

function isNullable(s) { return Array.isArray(s) && s.some(x => x === 'null' || (x && x.type === 'null')); }

function avroKind(s) {
  if (Array.isArray(s)) { const rest = s.filter(x => x !== 'null'); return rest.length === 1 ? avroKind(rest[0]) : 'nested'; }
  const t = typeof s === 'string' ? s : s && s.logicalType ? s.logicalType : s && s.type;
  if (typeof t === 'object') return avroKind(t);
  if (['int', 'long', 'float', 'double', 'decimal'].includes(t)) return 'num';
  if (t === 'boolean') return 'bool';
  if (['string', 'enum', 'uuid'].includes(t)) return 'str';
  if (/^(timestamp|local-timestamp|date|time)/.test(t)) return 'time';
  if (t === 'bytes' || t === 'fixed') return 'bin';
  return 'nested';
}

/** Resolve named references so plain() can follow them. */
function namedTypes(schema, out = {}, ns = '') {
  if (Array.isArray(schema)) { schema.forEach(s => namedTypes(s, out, ns)); return out; }
  if (!schema || typeof schema !== 'object') return out;
  const space = schema.namespace !== undefined ? schema.namespace : ns;
  if (schema.name && ['record', 'error', 'enum', 'fixed'].includes(schema.type)) {
    const full = schema.name.includes('.') || !space ? schema.name : `${space}.${schema.name}`;
    out[full] = schema;
    out[schema.name] = out[schema.name] || schema;
  }
  if (schema.fields) schema.fields.forEach(f => namedTypes(f.type, out, space));
  if (schema.items) namedTypes(schema.items, out, space);
  if (schema.values) namedTypes(schema.values, out, space);
  if (typeof schema.type === 'object') namedTypes(schema.type, out, space);
  return out;
}

function pad(n, w = 2) { return String(n).padStart(w, '0'); }

/** Convert a decoded Avro value to a plain value using the writer schema (logical types). */
function avroPlain(v, s, named, depth = 0) {
  if (v === null || v === undefined) return null;
  if (depth > 32) return V.plain(v, depth);
  if (typeof s === 'string') {
    if (named[s]) return avroPlain(v, named[s], named, depth);
    return v instanceof Uint8Array ? V.hex(v) : V.plain(v, depth);
  }
  if (Array.isArray(s)) {
    // avsc unwraps unions of null and one type; others come as {branch: value}
    const rest = s.filter(x => x !== 'null');
    if (rest.length === 1) return avroPlain(v, rest[0], named, depth);
    if (v && typeof v === 'object' && !Buffer.isBuffer(v)) {
      const keys = Object.keys(v);
      if (keys.length === 1) {
        const branch = rest.find(x => (typeof x === 'string' ? x : x.name || x.type) === keys[0] || (x && x.name && keys[0].endsWith('.' + x.name)));
        if (branch) return avroPlain(v[keys[0]], branch, named, depth);
      }
    }
    return V.plain(v, depth);
  }
  if (!s || typeof s !== 'object') return V.plain(v, depth);
  const lt = s.logicalType;
  if (lt === 'decimal' && Buffer.isBuffer(v)) return V.decimalFromBytes(v, s.scale || 0);
  if (lt === 'date' && typeof v === 'number') return V.isoMs(v * 86400000).slice(0, 10);
  if ((lt === 'timestamp-millis' || lt === 'local-timestamp-millis') && v !== null) return V.isoMs(Number(v)).replace(/Z$/, lt.startsWith('local') ? '' : 'Z');
  if (lt === 'timestamp-micros' || lt === 'local-timestamp-micros' || lt === 'timestamp-nanos' || lt === 'local-timestamp-nanos') {
    const per = lt.endsWith('nanos') ? 1000000n : 1000n;
    const big = BigInt(v);
    let ms = big / per, rem = big % per;
    if (rem < 0n) { rem += per; ms -= 1n; }
    const base = V.isoMs(Number(ms)).replace(/(\.\d{3})?Z$/, (m, f) => (f || '.000'));
    return base + rem.toString().padStart(per === 1000n ? 3 : 6, '0') + (lt.startsWith('local') ? '' : 'Z');
  }
  if (lt === 'time-millis' && typeof v === 'number') return `${pad(Math.floor(v / 3600000))}:${pad(Math.floor(v / 60000) % 60)}:${pad(Math.floor(v / 1000) % 60)}.${pad(v % 1000, 3)}`;
  if (lt === 'time-micros') { const n = Number(v); const ms = Math.floor(n / 1000); return `${pad(Math.floor(ms / 3600000))}:${pad(Math.floor(ms / 60000) % 60)}:${pad(Math.floor(ms / 1000) % 60)}.${pad(n % 1000000, 6)}`; }
  switch (s.type) {
    case 'record': case 'error': {
      const o = {};
      for (const f of s.fields) o[f.name] = avroPlain(v[f.name], f.type, named, depth + 1);
      return o;
    }
    case 'array': return Array.isArray(v) ? v.map(x => avroPlain(x, s.items, named, depth + 1)) : V.plain(v, depth);
    case 'map': { const o = {}; for (const k of Object.keys(v)) o[k] = avroPlain(v[k], s.values, named, depth + 1); return o; }
    case 'fixed': case 'bytes': return Buffer.isBuffer(v) ? V.hex(v) : V.plain(v, depth);
    default:
      if (typeof s.type === 'object' || named[s.type]) return avroPlain(v, typeof s.type === 'object' ? s.type : named[s.type], named, depth);
      return v instanceof Uint8Array ? V.hex(v) : V.plain(v, depth);
  }
}

class AvroDoc {
  constructor({ source, name }) {
    this.source = source;
    this.name = name;
    this.kind = 'avro';
    this.format = 'Avro container';
    this.size = 0;
    this.columns = [];
    this.batches = []; // blocks: {start, rows, pos, bytes}
    this.count = 0;
    this.done = false;
    this.bytesRead = 0;
    this.cache = new Map();
    this.cancelled = false;
    this.whenDone = Promise.resolve();
  }

  async open({ onProgress } = {}) {
    await this.source.open();
    this.size = this.source.size;
    if (this.size > L.MAX_FILE_BYTES) throw new ReadError(`This file is ${fmtGB(this.size)}. Files over 4 GB are not opened, so VS Code stays responsive.`, 'TOO_BIG');
    let want = 64 * 1024, hdr = null;
    while (!hdr) {
      const buf = await this.source.read(0, want);
      hdr = parseHeader(buf);
      if (hdr) break;
      if (buf.length < want || want >= 64 * 1024 * 1024) throw new ReadError('The Avro file header is cut off or damaged.', 'BAD');
      want *= 4;
    }
    this.sync = hdr.sync;
    this.codec = hdr.meta['avro.codec'] ? hdr.meta['avro.codec'].toString('utf8') : 'null';
    if (!CODECS[this.codec]) throw new ReadError(`This Avro file uses the "${this.codec}" codec. Supported codecs: null, deflate, snappy and zstandard.`, 'CODEC');
    let schema;
    try { schema = JSON.parse(hdr.meta['avro.schema'].toString('utf8')); } catch { throw new ReadError('The Avro schema in the file header is missing or not valid JSON.', 'BAD'); }
    this.schemaJson = schema;
    try {
      this.type = avro.Type.forSchema(decodingSchema(schema), { registry: { long: SafeLong }, wrapUnions: 'auto' });
    } catch (e) { throw new ReadError('The Avro schema could not be read: ' + e.message, 'BAD'); }
    this.named = namedTypes(schema);
    const top = typeof schema === 'string' && this.named[schema] ? this.named[schema] : schema;
    this.isRecord = top && typeof top === 'object' && !Array.isArray(top) && (top.type === 'record' || top.type === 'error');
    this.fields = this.isRecord ? top.fields : [{ name: '(value)', type: schema }];
    this.columns = this.fields.map((f, i) => ({
      i, name: f.name, type: avroTypeName(f.type), nullable: isNullable(f.type), kind: avroKind(f.type),
      doc: f.doc || '', default: f.default === undefined ? undefined : f.default, meta: null,
    }));
    const meta = {};
    for (const [k, v] of Object.entries(hdr.meta)) if (k !== 'avro.schema' && k !== 'avro.codec') meta[k] = v.toString('utf8').slice(0, 2000);
    this.meta = Object.keys(meta).length ? meta : null;
    this.next = hdr.end;
    await this.indexSome(64);
    if (onProgress) onProgress(this.progress());
    this.whenDone = this.done ? Promise.resolve() : this.indexRest(onProgress);
    this.whenDone.catch(() => {});
  }

  async indexSome(maxBlocks) {
    let n = 0;
    while (!this.done && !this.cancelled && n < maxBlocks) {
      if (this.next >= this.size) { this.done = true; break; }
      const h = await this.source.read(this.next, 20);
      const c = readLong(h, 0);
      const z = c && readLong(h, c.pos);
      if (!c || !z || c.value < 0 || z.value < 0) throw new ReadError(`Damaged Avro block header at byte ${this.next}.`, 'BAD');
      const dataPos = this.next + z.pos;
      const end = dataPos + z.value + 16;
      if (end > this.size) throw new ReadError(`The file ends inside an Avro block (byte ${this.next}). It may be cut off.`, 'BAD');
      const sync = await this.source.read(dataPos + z.value, 16);
      if (!sync.equals(this.sync)) throw new ReadError(`Avro sync marker mismatch after the block at byte ${this.next}. The file is damaged.`, 'BAD');
      this.batches.push({ start: this.count, rows: c.value, pos: dataPos, bytes: z.value });
      this.count += c.value;
      this.next = end;
      this.bytesRead = end;
      n++;
    }
  }

  async indexRest(onProgress) {
    let last = Date.now();
    while (!this.done && !this.cancelled) {
      await this.indexSome(512);
      const now = Date.now();
      if (onProgress && now - last > 200) { last = now; onProgress(this.progress()); }
      await new Promise(r => setImmediate(r));
    }
    if (onProgress) onProgress(this.progress());
  }

  progress() { return { count: this.count, batches: this.batches.length, done: this.done, bytes: this.bytesRead, size: this.size }; }

  batchOf(row) {
    const b = this.batches;
    let lo = 0, hi = b.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (b[mid].start <= row) lo = mid; else hi = mid - 1; }
    return lo;
  }

  async getBatch(k) {
    const hit = this.cache.get(k);
    if (hit) { this.cache.delete(k); this.cache.set(k, hit); return hit; }
    const b = this.batches[k];
    if (b.bytes > L.MAX_BATCH_BYTES) throw new ReadError(`Avro block ${k + 1} is ${fmtGB(b.bytes)}, over the 1 GB limit for one block.`, 'TOO_BIG');
    const raw = await this.source.read(b.pos, b.bytes);
    let data;
    try { data = CODECS[this.codec](raw); } catch (e) { throw new ReadError(`Could not decompress Avro block ${k + 1} (${this.codec}): ${e.message}`, 'BAD'); }
    const records = new Array(b.rows);
    let pos = 0;
    for (let i = 0; i < b.rows; i++) {
      const r = this.type.decode(data, pos);
      if (r.offset < 0) throw new ReadError(`Avro block ${k + 1} is shorter than its ${b.rows} records. The file is damaged.`, 'BAD');
      records[i] = r.value;
      pos = r.offset;
    }
    const entry = { k, start: b.start, rows: b.rows, records };
    this.cache.set(k, entry);
    while (this.cache.size > L.BATCH_CACHE) this.cache.delete(this.cache.keys().next().value);
    return entry;
  }

  field(entry, i, c) {
    const rec = entry.records[i];
    return this.isRecord ? (rec == null ? null : rec[this.fields[c].name]) : rec;
  }

  value(entry, i, c) { return avroPlain(this.field(entry, i, c), this.fields[c].type, this.named); }

  raw(entry, i, c) {
    const v = this.field(entry, i, c);
    if (v === null || v === undefined) return null;
    if (typeof v === 'number') return v;
    return this.value(entry, i, c);
  }

  schemaInfo() {
    return {
      kind: 'avro', format: this.format, codec: this.codec, batches: this.batches.length, metadata: this.meta,
      fields: this.columns.map(c => ({ ...c })), schemaText: JSON.stringify(this.schemaJson, null, 2).slice(0, 200000),
    };
  }

  async close() { this.cancelled = true; this.cache.clear(); await this.source.close(); }
}

module.exports = { AvroDoc, decodingSchema, parseHeader, readLong, avroTypeName, avroPlain, CODECS, SafeLong };
