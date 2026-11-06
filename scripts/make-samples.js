'use strict';
// Writes the sample files in samples/ (all invented data, each under 5 MB).
// Usage: node scripts/make-samples.js [outDir]
const fs = require('fs');
const path = require('path');
const A = require('apache-arrow');
const avro = require('avsc');
const lz4 = require('lz4js');
const snappy = require('snappyjs');
require('../src/core/arrowdoc'); // registers the LZ4/ZSTD decoders
const { decodingSchema } = require('../src/core/avrodoc');

A.compressionRegistry.set(A.CompressionType.LZ4_FRAME, { encode: b => lz4.compress(b), decode: b => lz4.decompress(b).slice() });

const out = path.resolve(process.argv[2] || path.join(__dirname, '..', 'samples'));
fs.mkdirSync(out, { recursive: true });

let seed = 42;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
const pick = a => a[Math.floor(rnd() * a.length)];
const T0 = Date.UTC(2026, 0, 1);

function writeArrow(file, cols, batchRows, { stream = false, compression = null } = {}) {
  const table = new A.Table(cols);
  const batches = [];
  for (let s = 0; s < table.numRows; s += batchRows) batches.push(...table.slice(s, Math.min(table.numRows, s + batchRows)).batches);
  const W = stream ? A.RecordBatchStreamWriter : A.RecordBatchFileWriter;
  const w = new W(compression == null ? {} : { compressionType: compression });
  for (const b of batches) w.write(b);
  w.finish();
  const bytes = w.toUint8Array(true);
  fs.writeFileSync(path.join(out, file), bytes);
  return bytes.length;
}

// 1. Taxi trips: Arrow IPC file, 60,000 rows in 6 batches.
{
  const n = 60000;
  const vendors = ['Northside Cabs', 'Blue Line', 'Metro Taxi', 'Harbor Rides'];
  const pay = ['card', 'cash', 'app', 'voucher'];
  const zones = ['Old Town', 'Riverside', 'Airport', 'Harbor', 'University', 'Market St', 'Hillcrest'];
  const id = [], at = [], vendor = [], pax = [], km = [], fare = [], payment = [], from = [], to = [], note = [];
  for (let i = 0; i < n; i++) {
    id.push(BigInt(100000 + i));
    at.push(T0 + i * 47000 + Math.floor(rnd() * 30000));
    vendor.push(pick(vendors));
    pax.push(rnd() < 0.03 ? null : 1 + Math.floor(rnd() * 4));
    const d = Math.round((0.6 + rnd() * rnd() * 28) * 100) / 100;
    km.push(d);
    fare.push(Math.round((3.2 + d * 1.85 + rnd() * 4) * 100) / 100);
    payment.push(pick(pay));
    from.push(pick(zones)); to.push(pick(zones));
    note.push(i === 7 ? '<b>not html</b> & "quotes"' : rnd() < 0.002 ? 'lost umbrella returned' : null);
  }
  const dict = () => new A.Dictionary(new A.Utf8(), new A.Int8());
  const size = writeArrow('taxi-trips.arrow', {
    trip_id: A.vectorFromArray(id, new A.Int64()),
    pickup_at: A.vectorFromArray(at, new A.TimestampMillisecond()),
    vendor: A.vectorFromArray(vendor, dict()),
    passengers: A.vectorFromArray(pax, new A.Int8()),
    distance_km: A.vectorFromArray(km, new A.Float64()),
    fare_usd: A.vectorFromArray(fare, new A.Float64()),
    payment: A.vectorFromArray(payment, dict()),
    pickup_zone: A.vectorFromArray(from, dict()),
    dropoff_zone: A.vectorFromArray(to, dict()),
    note: A.vectorFromArray(note, new A.Utf8()),
  }, 10000);
  console.log('taxi-trips.arrow', size);
}

// 2. Sensor readings: Feather V2 with LZ4 frame compression, 40,000 rows.
{
  const n = 40000;
  const sensors = ['greenhouse-1', 'greenhouse-2', 'cold-room', 'roof', 'basement'];
  const sid = [], ts = [], temp = [], hum = [], ok = [], loc = [], tags = [];
  const where = { 'greenhouse-1': [52.371, 4.896], 'greenhouse-2': [52.372, 4.899], 'cold-room': [52.368, 4.902], roof: [52.37, 4.9], basement: [52.369, 4.897] };
  for (let i = 0; i < n; i++) {
    const s = sensors[i % sensors.length];
    sid.push(s);
    ts.push(T0 + Math.floor(i / sensors.length) * 60000);
    const base = s === 'cold-room' ? 3 : s === 'roof' ? 9 : s === 'basement' ? 14 : 22;
    temp.push(rnd() < 0.01 ? null : Math.round((base + Math.sin(i / 900) * 3 + rnd()) * 10) / 10);
    hum.push(Math.round(40 + rnd() * 45));
    ok.push(rnd() > 0.004);
    loc.push({ lat: where[s][0], lon: where[s][1] });
    tags.push(rnd() < 0.1 ? ['check', 'battery'] : rnd() < 0.2 ? ['check'] : []);
  }
  const size = writeArrow('sensor-readings.feather', {
    sensor: A.vectorFromArray(sid, new A.Dictionary(new A.Utf8(), new A.Int8())),
    read_at: A.vectorFromArray(ts, new A.TimestampMillisecond('UTC')),
    temp_c: A.vectorFromArray(temp, new A.Float32()),
    humidity_pct: A.vectorFromArray(hum, new A.Int16()),
    ok: A.vectorFromArray(ok, new A.Bool()),
    location: A.vectorFromArray(loc, new A.Struct([new A.Field('lat', new A.Float64()), new A.Field('lon', new A.Float64())])),
    tags: A.vectorFromArray(tags, new A.List(new A.Field('item', new A.Utf8(), true))),
  }, 8000, { compression: A.CompressionType.LZ4_FRAME });
  console.log('sensor-readings.feather', size);
}

// 3. App events: Arrow IPC stream format with the .ipc extension, 12,000 rows in 4 batches.
{
  const n = 12000;
  const kinds = ['page_view', 'click', 'signup', 'purchase', 'error'];
  const ts = [], user = [], kind = [], ms = [], pathc = [];
  for (let i = 0; i < n; i++) {
    ts.push(T0 + i * 5000);
    user.push(`u${1000 + Math.floor(rnd() * 800)}`);
    const k = rnd() < 0.02 ? 'error' : pick(kinds.slice(0, 4));
    kind.push(k);
    ms.push(Math.round(20 + rnd() * rnd() * 2400));
    pathc.push(pick(['/', '/pricing', '/docs', '/signup', '/checkout', '/blog/arrow-tips']));
  }
  const size = writeArrow('app-events.ipc', {
    at: A.vectorFromArray(ts, new A.TimestampMillisecond()),
    user_id: A.vectorFromArray(user, new A.Utf8()),
    event: A.vectorFromArray(kind, new A.Utf8()),
    latency_ms: A.vectorFromArray(ms, new A.Int32()),
    path: A.vectorFromArray(pathc, new A.Utf8()),
  }, 3000, { stream: true });
  console.log('app-events.ipc', size);
}

// 4. Customers: Avro container with the deflate codec and nested, nullable and logical types.
const customerSchema = {
  type: 'record', name: 'Customer', namespace: 'demo.shop', doc: 'Invented customers for the sample file',
  fields: [
    { name: 'id', type: 'long' },
    { name: 'email', type: 'string' },
    { name: 'plan', type: { type: 'enum', name: 'Plan', symbols: ['FREE', 'TEAM', 'BUSINESS'] } },
    { name: 'signup_date', type: { type: 'int', logicalType: 'date' } },
    { name: 'last_login', type: ['null', { type: 'long', logicalType: 'timestamp-millis' }], default: null },
    { name: 'balance', type: { type: 'bytes', logicalType: 'decimal', precision: 10, scale: 2 } },
    { name: 'tags', type: { type: 'array', items: 'string' } },
    { name: 'prefs', type: { type: 'map', values: 'string' } },
    { name: 'address', type: ['null', { type: 'record', name: 'Address', fields: [{ name: 'city', type: 'string' }, { name: 'country', type: 'string' }] }], default: null },
    { name: 'external_ref', type: ['null', 'long'], default: null, doc: 'Some ids are larger than 2^53' },
  ],
};
function decBytes(cents) {
  let v = BigInt(cents);
  const bytes = [];
  for (let i = 0; i < 8; i++) { bytes.unshift(Number(v & 0xffn)); v >>= 8n; }
  return Buffer.from(bytes);
}
// Long values over 2^53 are written as BigInt with a custom long type (unions are wrapped: {long: v}).
const BigLong = avro.types.LongType.__with({
  fromBuffer: b => b.readBigInt64LE(0), toBuffer: n => { const b = Buffer.alloc(8); b.writeBigInt64LE(BigInt(n)); return b; },
  fromJSON: x => BigInt(x), toJSON: x => Number(x), isValid: x => typeof x === 'bigint', compare: (a, b) => (a < b ? -1 : a > b ? 1 : 0),
});

function writeAvro(file, schema, rows, codec, blockRows) {
  const type = avro.Type.forSchema(decodingSchema(schema), { registry: { long: BigLong }, wrapUnions: true });
  const codecs = {
    null: b => b,
    deflate: b => require('zlib').deflateRawSync(b),
    snappy: b => {
      const c = Buffer.from(snappy.compress(b));
      const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(b) >>> 0);
      return Buffer.concat([c, crc]);
    },
  };
  const sync = Buffer.alloc(16);
  for (let i = 0; i < 16; i++) sync[i] = Math.floor(rnd() * 256);
  const meta = { 'avro.schema': Buffer.from(JSON.stringify(schema)), 'avro.codec': Buffer.from(codec), 'writer': Buffer.from('zovo make-samples.js') };
  const mapType = avro.Type.forSchema({ type: 'map', values: 'bytes' });
  const parts = [Buffer.from('Obj\x01', 'latin1'), mapType.toBuffer(meta), sync];
  const longT = avro.Type.forSchema('long');
  for (let s = 0; s < rows.length; s += blockRows) {
    const chunk = rows.slice(s, s + blockRows);
    const data = codecs[codec](Buffer.concat(chunk.map(r => type.toBuffer(r))));
    parts.push(longT.toBuffer(chunk.length), longT.toBuffer(data.length), data, sync);
  }
  const buf = Buffer.concat(parts);
  fs.writeFileSync(path.join(out, file), buf);
  console.log(file, buf.length);
}

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return crc ^ 0xffffffff;
}

{
  const first = ['ana', 'ben', 'chloe', 'dev', 'emre', 'fatima', 'gus', 'hana', 'ivo', 'jun'];
  const cities = [['Lisbon', 'PT'], ['Utrecht', 'NL'], ['Leeds', 'GB'], ['Lyon', 'FR'], ['Porto', 'PT'], ['Graz', 'AT']];
  const rows = [];
  for (let i = 0; i < 8000; i++) {
    const c = pick(cities);
    rows.push({
      id: BigInt(i + 1),
      email: `${pick(first)}.${i}@example.com`,
      plan: pick(['FREE', 'FREE', 'TEAM', 'BUSINESS']),
      signup_date: 19000 + Math.floor(rnd() * 1500),
      last_login: rnd() < 0.15 ? null : { long: BigInt(T0 + Math.floor(rnd() * 3e9)) },
      balance: decBytes(Math.round((rnd() - 0.2) * 50000)),
      tags: rnd() < 0.3 ? ['beta'] : rnd() < 0.1 ? ['vip', 'beta'] : [],
      prefs: rnd() < 0.5 ? { theme: pick(['dark', 'light']), lang: pick(['en', 'pt', 'nl', 'fr']) } : {},
      address: rnd() < 0.1 ? null : { 'demo.shop.Address': { city: c[0], country: c[1] } },
      external_ref: i % 1000 === 3 ? { long: 9007199254740993n + BigInt(i) } : rnd() < 0.5 ? null : { long: BigInt(500000 + i) },
    });
  }
  rows[5].email = '<script>alert(1)</script>@example.com';
  writeAvro('customers.avro', customerSchema, rows, 'deflate', 1000);
}

// 5. Clicks: Avro container with the snappy codec, 30,000 rows.
{
  const schema = {
    type: 'record', name: 'Click', fields: [
      { name: 'at', type: { type: 'long', logicalType: 'timestamp-micros' } },
      { name: 'session', type: 'string' },
      { name: 'x', type: 'int' }, { name: 'y', type: 'int' },
      { name: 'button', type: ['null', 'string'], default: null },
      { name: 'score', type: 'double' },
    ],
  };
  const rows = [];
  for (let i = 0; i < 30000; i++) {
    rows.push({ at: BigInt(T0) * 1000n + BigInt(i) * 1234567n, session: `s-${(i / 40) | 0}`, x: Math.floor(rnd() * 1920), y: Math.floor(rnd() * 1080), button: rnd() < 0.7 ? null : { string: pick(['buy', 'next', 'close']) }, score: Math.round(rnd() * 1000) / 1000 });
  }
  writeAvro('clicks-snappy.avro', schema, rows, 'snappy', 4000);
}
