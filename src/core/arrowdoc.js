'use strict';
// Arrow IPC (file and stream format) and Feather V2 reader with random access to record batches.
// The file is never read whole: a header pass records where each message starts, then a batch is
// read on demand as [schema, dictionaries..., batch, end] and decoded by apache-arrow.

const A = require('apache-arrow');
const { Footer } = require('apache-arrow/ipc/metadata/file');
const lz4 = require('lz4js');
const zstd = require('fzstd');
const L = require('./limits');
const V = require('./values');

const aligned = u8 => (u8.byteOffset % 8 === 0 ? u8 : u8.slice());
A.compressionRegistry.set(A.CompressionType.LZ4_FRAME, { decode: b => aligned(lz4.decompress(b)) });
A.compressionRegistry.set(A.CompressionType.ZSTD, { decode: b => aligned(zstd.decompress(b)) });

const MAGIC = Buffer.from('ARROW1');
const EOS = Buffer.from([0xff, 0xff, 0xff, 0xff, 0, 0, 0, 0]);
const T = A.Type;

class ReadError extends Error {
  constructor(message, code) { super(message); this.code = code || 'READ'; }
}

function typeName(type) {
  if (type.typeId === T.Dictionary) return `dictionary<${typeName(type.dictionary)}>`;
  if (type.typeId === T.Decimal) return `Decimal${type.bitWidth || 128}(${type.precision}, ${type.scale})`;
  return String(type);
}

/** Display kind per Arrow type: num, bool, str, time, bin, nested. */
function arrowKind(type) {
  const id = type.typeId === T.Dictionary ? type.dictionary.typeId : type.typeId;
  if ([T.Int, T.Float, T.Decimal, T.Duration].includes(id)) return 'num';
  if (id === T.Bool) return 'bool';
  if ([T.Utf8, T.LargeUtf8, T.Utf8View].includes(id)) return 'str';
  if ([T.Timestamp, T.Date, T.Time, T.Interval].includes(id)) return 'time';
  if ([T.Binary, T.LargeBinary, T.FixedSizeBinary, T.BinaryView].includes(id)) return 'bin';
  if (id === T.Null) return 'str';
  return 'nested';
}

function pad(n, w = 2) { return String(n).padStart(w, '0'); }
function timeOfDay(v, unit) {
  // unit: 0 s, 1 ms, 2 us, 3 ns
  const per = [1n, 1000n, 1000000n, 1000000000n][unit] || 1n;
  const big = typeof v === 'bigint' ? v : BigInt(Math.trunc(v));
  const sec = big / per, frac = big % per;
  const s = Number(sec);
  let out = `${pad(Math.floor(s / 3600))}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}`;
  if (unit > 0) out += '.' + frac.toString().padStart(String(per).length - 1, '0');
  return out;
}

/** Convert one Arrow value to a JSON-safe plain value, using the column type. */
function arrowPlain(v, type, depth = 0) {
  if (v === null || v === undefined) return null;
  if (!type || depth > 32) return V.plain(v, depth);
  switch (type.typeId) {
    case T.Dictionary: return arrowPlain(v, type.dictionary, depth);
    case T.Int: case T.Duration: return typeof v === 'bigint' ? V.bigToPlain(v) : v;
    case T.Float: return !Number.isFinite(v) ? String(v) : type.precision === 1 ? Number(v.toPrecision(7)) : type.precision === 0 ? Number(v.toPrecision(4)) : v;
    case T.Timestamp: {
      const ms = typeof v === 'bigint' ? Number(v) : v;
      return V.isoMs(Math.floor(ms)).replace(/(\.\d{3})?Z$/, (m, f) => {
        const sub = ms - Math.floor(ms);
        const extra = type.unit >= 2 && sub ? String(Math.round(sub * 1000)).padStart(3, '0') : '';
        return (f || (extra ? '.000' : '')) + extra + 'Z';
      });
    }
    case T.Date: return V.isoMs(typeof v === 'bigint' ? Number(v) : v instanceof Date ? v.getTime() : v).slice(0, 10);
    case T.Time: return timeOfDay(v, type.unit);
    case T.Decimal: {
      let big;
      try { big = BigInt(String(v)); } catch { return String(v); }
      return V.scaleBig(big, type.scale);
    }
    case T.Binary: case T.LargeBinary: case T.FixedSizeBinary: case T.BinaryView:
      return v instanceof Uint8Array ? V.hex(v) : V.plain(v, depth);
    case T.List: case T.LargeList: case T.FixedSizeList: case T.ListView: case T.LargeListView: {
      const child = type.children && type.children[0] && type.children[0].type;
      const out = [];
      for (const x of v) out.push(arrowPlain(x, child, depth + 1));
      return out;
    }
    case T.Struct: {
      const o = {};
      for (const f of type.children) o[f.name] = arrowPlain(v[f.name], f.type, depth + 1);
      return o;
    }
    case T.Map: {
      const entry = type.children[0] && type.children[0].type;
      const kt = entry && entry.children[0] && entry.children[0].type;
      const vt = entry && entry.children[1] && entry.children[1].type;
      const o = {};
      for (const [k, x] of v) o[String(arrowPlain(k, kt, depth + 1))] = arrowPlain(x, vt, depth + 1);
      return o;
    }
    default: return V.plain(v, depth);
  }
}

class ArrowDoc {
  /** @param {{source, name:string}} p */
  constructor({ source, name }) {
    this.source = source;
    this.name = name;
    this.kind = 'arrow';
    this.format = '';
    this.size = 0;
    this.columns = [];
    this.batches = []; // {start, rows, pos, end, bytes}
    this.dicts = []; // {pos, end}
    this.schemaMsg = null; // {pos, end}
    this.count = 0;
    this.done = false;
    this.bytesRead = 0;
    this.compression = '';
    this.info = {};
    this.cache = new Map();
    this.cancelled = false;
    this.whenDone = Promise.resolve();
  }

  /** Read the header and index the first batches; the rest is indexed in the background (whenDone). */
  async open({ onProgress } = {}) {
    await this.source.open();
    this.size = this.source.size;
    if (this.size > L.MAX_FILE_BYTES) throw new ReadError(`This file is ${fmtGB(this.size)}. Files over 4 GB are not opened, so VS Code stays responsive.`, 'TOO_BIG');
    if (this.size < 8) throw new ReadError('This file is too small to be an Arrow or Feather file.', 'BAD');
    const head = await this.source.read(0, 12);
    let pos = 0;
    if (head.subarray(0, 4).toString('latin1') === 'FEA1') {
      throw new ReadError('This is a Feather V1 file (written before 2020). Only Feather V2 (Arrow IPC) is supported. Save it again with pyarrow.feather.write_feather or pandas to_feather to get V2.', 'V1');
    }
    if (head.subarray(0, 6).equals(MAGIC)) {
      this.format = 'Arrow IPC file';
      pos = 8;
    } else {
      this.format = 'Arrow IPC stream';
    }
    if (/\.feather$/i.test(this.name) && this.format === 'Arrow IPC file') this.format = 'Feather V2';
    this.fileFormat = pos === 8;
    let footer = null;
    if (this.fileFormat) footer = await this.readFooter();
    let version;
    if (footer) {
      this.schema = footer.schema;
      version = footer.version;
      this.schemaBytes = schemaMessage(this.schema);
      this.blocks = { batches: [...footer.recordBatches()], dicts: [...footer.dictionaryBatches()], next: 0 };
      for (const d of this.blocks.dicts) {
        const at = Number(d.offset);
        this.dicts.push({ pos: at, end: at + d.metaDataLength + Number(d.bodyLength), batchIndex: 0 });
      }
    } else {
      // Stream format (or a file without a readable footer): the first message must be the schema.
      let first = null;
      try { first = await this.readMessage(pos); } catch { first = null; }
      if (!first || !first.msg.isSchema()) throw new ReadError('No Arrow schema at the start of the file. It is not an Arrow IPC or Feather V2 file, or it is damaged.', 'BAD');
      this.schema = first.msg.header();
      version = first.msg.version;
      this.schemaBytes = await this.source.read(first.pos, first.end - first.pos);
      this.next = first.end;
    }
    this.columns = this.schema.fields.map((f, i) => ({
      i, name: f.name || `column_${i + 1}`, type: typeName(f.type), nullable: !!f.nullable, kind: arrowKind(f.type),
      meta: metaObj(f.metadata),
    }));
    this.types = this.schema.fields.map(f => f.type);
    this.info = { metadata: metaObj(this.schema.metadata), version: 'V' + (Number(version) + 1) };
    // Index until the first rows are known, then continue in the background.
    await this.indexSome(16, onProgress);
    this.whenDone = this.done ? Promise.resolve() : this.indexRest(onProgress);
    this.whenDone.catch(() => {});
  }

  async indexSome(maxBatches, onProgress) {
    let n = 0;
    if (this.blocks) {
      const list = this.blocks.batches;
      while (this.blocks.next < list.length && n < maxBatches && !this.cancelled) {
        const blk = list[this.blocks.next++];
        const m = await this.readMessage(Number(blk.offset));
        if (!m || !m.msg.isRecordBatch()) throw new ReadError(`The file footer points to a damaged record batch at byte ${blk.offset}.`, 'BAD');
        this.addBatch(m);
        n++;
      }
      if (this.blocks.next >= list.length) this.done = true;
      if (onProgress) onProgress(this.progress());
      return;
    }
    while (!this.done && !this.cancelled) {
      const m = this.next + 8 <= this.size ? await this.readMessage(this.next) : null;
      if (!m) { this.done = true; break; }
      if (m.msg.isRecordBatch()) {
        this.addBatch(m);
        n++;
      } else if (m.msg.isDictionaryBatch()) {
        this.dicts.push({ pos: m.pos, end: m.end, batchIndex: this.batches.length });
      }
      this.next = m.end;
      this.bytesRead = m.end;
      if (n >= maxBatches) break;
    }
    if (onProgress) onProgress(this.progress());
  }

  addBatch(m) {
    const h = m.msg.header();
    const rows = Number(h.length);
    if (h.compression) this.compression = ['LZ4 frame', 'ZSTD'][h.compression.type] || 'compressed';
    this.batches.push({ start: this.count, rows, pos: m.pos, end: m.end, bytes: m.end - m.pos });
    this.count += rows;
    this.bytesRead = m.end;
  }

  /** Footer of the IPC file format, or null if it is missing or damaged. */
  async readFooter() {
    if (this.size < 18) return null;
    const tail = await this.source.read(this.size - 10, 10);
    if (!tail.subarray(4, 10).equals(MAGIC)) return null;
    const len = tail.readInt32LE(0);
    if (len <= 0 || len > this.size - 18) return null;
    const buf = await this.source.read(this.size - 10 - len, len);
    try { return Footer.decode(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)); } catch { return null; }
  }

  async indexRest(onProgress) {
    let last = Date.now();
    while (!this.done && !this.cancelled) {
      await this.indexSome(256, null);
      const now = Date.now();
      if (onProgress && now - last > 200) { last = now; onProgress(this.progress()); }
      await new Promise(r => setImmediate(r));
    }
    if (onProgress) onProgress(this.progress());
  }

  progress() { return { count: this.count, batches: this.batches.length, done: this.done, bytes: this.bytesRead, size: this.size }; }

  /** Read one IPC message frame at pos. Returns null at the end-of-stream marker or the file footer. */
  async readMessage(pos) {
    const pre = await this.source.read(pos, 8);
    if (pre.length < 4) return null;
    let metaLen, metaStart;
    if (pre.readUInt32LE(0) === 0xffffffff) {
      if (pre.length < 8) return null;
      metaLen = pre.readInt32LE(4);
      metaStart = pos + 8;
    } else {
      metaLen = pre.readInt32LE(0); // pre-0.15 format without the continuation marker
      metaStart = pos + 4;
    }
    if (metaLen === 0) return null;
    if (metaLen < 0 || metaStart + metaLen > this.size) {
      // In the file format the footer follows the last message without an end marker.
      if (this.fileFormat && pre.subarray(0, 6).equals(MAGIC)) return null;
      throw new ReadError(`Damaged Arrow message at byte ${pos}.`, 'BAD');
    }
    const meta = await this.source.read(metaStart, metaLen);
    let msg;
    try { msg = A.Message.decode(new Uint8Array(meta.buffer, meta.byteOffset, meta.byteLength)); } catch (e) {
      if (this.fileFormat && pos > 8) return null; // footer flatbuffer
      throw new ReadError(`Damaged Arrow message at byte ${pos}: ${e.message}`, 'BAD');
    }
    const end = metaStart + metaLen + Number(msg.bodyLength);
    if (end > this.size) throw new ReadError(`The file ends inside a record batch (byte ${pos}). It may be cut off.`, 'BAD');
    return { msg, pos, end };
  }

  batchOf(row) {
    const b = this.batches;
    let lo = 0, hi = b.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (b[mid].start <= row) lo = mid; else hi = mid - 1; }
    return lo;
  }

  /** Decoded record batch k (cached). */
  async getBatch(k) {
    const hit = this.cache.get(k);
    if (hit) { this.cache.delete(k); this.cache.set(k, hit); return hit; }
    const b = this.batches[k];
    if (b.bytes > L.MAX_BATCH_BYTES) throw new ReadError(`Record batch ${k + 1} is ${fmtGB(b.bytes)}, over the 1 GB limit for one batch. Write the file with smaller batches (for example max_chunksize in pyarrow).`, 'TOO_BIG');
    const parts = [this.schemaBytes];
    for (const d of this.dicts) if (d.batchIndex <= k) parts.push(await this.source.read(d.pos, d.end - d.pos));
    parts.push(await this.source.read(b.pos, b.end - b.pos), EOS);
    const bytes = Buffer.concat(parts);
    let batch;
    try {
      const reader = A.RecordBatchReader.from(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength));
      const r = reader.next();
      batch = r && r.value;
    } catch (e) {
      throw new ReadError(`Could not decode record batch ${k + 1}: ${e.message}`, 'BAD');
    }
    if (!batch) throw new ReadError(`Record batch ${k + 1} is empty or damaged.`, 'BAD');
    const vectors = this.columns.map((c, i) => batch.getChildAt(i));
    const entry = { k, start: b.start, rows: b.rows, vectors };
    this.cache.set(k, entry);
    while (this.cache.size > L.BATCH_CACHE) this.cache.delete(this.cache.keys().next().value);
    return entry;
  }

  /** Plain value of row i (inside the batch) and column c. */
  value(entry, i, c) {
    const vec = entry.vectors[c];
    if (!vec) return null;
    return arrowPlain(vec.get(i), this.types[c]);
  }

  /** Raw value for stats (numbers stay numbers, big ints stay bigint). */
  raw(entry, i, c) {
    const vec = entry.vectors[c];
    if (!vec) return null;
    const v = vec.get(i);
    if (v === null || v === undefined) return null;
    const t = this.types[c];
    const id = t.typeId === T.Dictionary ? t.dictionary.typeId : t.typeId;
    if (id === T.Int || id === T.Float || id === T.Duration) return v;
    if (id === T.Timestamp || id === T.Date) return typeof v === 'bigint' ? Number(v) : v;
    return arrowPlain(v, t);
  }

  schemaInfo() {
    const fields = this.schema.fields.map((f, i) => ({ ...this.columns[i], tree: fieldTree(f) }));
    return {
      kind: 'arrow', format: this.format, version: this.info.version, compression: this.compression || 'none',
      batches: this.batches.length, dictionaries: this.dicts.length, metadata: this.info.metadata, fields,
    };
  }

  async close() { this.cancelled = true; this.cache.clear(); await this.source.close(); }
}

/** Framed IPC schema message (continuation marker, length, flatbuffer, padding to 8). */
function schemaMessage(schema) {
  const fb = A.Message.encode(A.Message.from(schema));
  const size = (fb.byteLength + 8 + 7) & ~7;
  const out = Buffer.alloc(size);
  out.writeInt32LE(-1, 0);
  out.writeInt32LE(size - 8, 4);
  Buffer.from(fb.buffer, fb.byteOffset, fb.byteLength).copy(out, 8);
  return out;
}

function fieldTree(f) {
  const kids = (f.type.typeId === T.Dictionary ? [] : f.type.children || []).map(fieldTree);
  return { name: f.name, type: typeName(f.type), nullable: !!f.nullable, children: kids };
}

function metaObj(m) {
  if (!m || !m.size) return null;
  const o = {};
  for (const [k, v] of m) o[k] = v;
  return o;
}

function fmtGB(n) { return n >= 1024 ** 3 ? (n / 1024 ** 3).toFixed(2) + ' GB' : (n / 1024 ** 2).toFixed(1) + ' MB'; }

module.exports = { ArrowDoc, ReadError, arrowPlain, arrowKind, typeName, fmtGB };
