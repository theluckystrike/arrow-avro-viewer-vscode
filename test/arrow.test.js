'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { execFileSync } = require('child_process');
const { tempDir, makeSamples, openFile, openBytes, rows, hasPyarrow } = require('./helpers');
const { ArrowDoc } = require('../src/core/arrowdoc');
const L = require('../src/core/limits');

const T = tempDir('arrow');
test.before(() => makeSamples(T.dir));
test.after(() => T.cleanup());

test('Arrow IPC file: footer index, batches, row count and values', async () => {
  const d = await openFile(T.file('taxi-trips.arrow'));
  assert.equal(d.format, 'Arrow IPC file');
  assert.equal(d.count, 60000);
  assert.equal(d.batches.length, 6);
  assert.deepEqual(d.columns.map(c => c.name), ['trip_id', 'pickup_at', 'vendor', 'passengers', 'distance_km', 'fare_usd', 'payment', 'pickup_zone', 'dropoff_zone', 'note']);
  assert.equal(d.columns[0].type, 'Int64');
  assert.equal(d.columns[2].type, 'dictionary<Utf8>');
  assert.equal(d.columns[1].kind, 'time');
  const [r0] = await rows(d, 0, 1);
  assert.equal(r0[0], 100000);
  assert.match(r0[1], /^2026-01-01T00:00:\d\d\.\d{3}Z$/);
  const [r7] = await rows(d, 7, 1);
  assert.equal(r7[9], '<b>not html</b> & "quotes"', 'text is kept as text');
  const [last] = await rows(d, 59999, 1);
  assert.equal(last[0], 159999);
  assert.equal(d.batchOf(0), 0);
  assert.equal(d.batchOf(10000), 1);
  assert.equal(d.batchOf(59999), 5);
  await d.close();
});

test('Arrow IPC stream (.ipc) is indexed message by message', async () => {
  const d = await openFile(T.file('app-events.ipc'));
  assert.equal(d.format, 'Arrow IPC stream');
  assert.equal(d.count, 12000);
  assert.equal(d.batches.length, 4);
  const r = await rows(d, 11999, 1);
  assert.equal(r[0].length, 5);
  await d.close();
});

test('Feather V2 with LZ4 frame compression: struct, list, float32 and dictionary', async () => {
  const d = await openFile(T.file('sensor-readings.feather'));
  assert.equal(d.format, 'Feather V2');
  assert.equal(d.compression, 'LZ4 frame');
  assert.equal(d.count, 40000);
  const [r] = await rows(d, 0, 1);
  assert.equal(r[0], 'greenhouse-1');
  assert.deepEqual(r[5], { lat: 52.371, lon: 4.896 });
  assert.ok(Array.isArray(r[6]));
  assert.equal(String(r[2]).length < 8, true, 'float32 is rounded to 7 digits');
  assert.equal(d.schemaInfo().compression, 'LZ4 frame');
  await d.close();
});

test('only the needed batch is decoded and the cache stays small', async () => {
  const d = await openFile(T.file('taxi-trips.arrow'));
  for (let k = 0; k < d.batches.length; k++) await d.getBatch(k);
  assert.ok(d.cache.size <= L.BATCH_CACHE);
  await d.close();
});

test('clear errors: Feather V1, not Arrow, cut off, over 4 GB', async () => {
  await assert.rejects(openBytes(Buffer.concat([Buffer.from('FEA1'), Buffer.alloc(64)]), 'old.feather'), /Feather V1/);
  await assert.rejects(openBytes(Buffer.from('hello world, not arrow at all'), 'x.arrow'), /not an Arrow IPC or Feather V2 file/);
  const full = fs.readFileSync(T.file('app-events.ipc'));
  await assert.rejects(openBytes(full.subarray(0, 300000), 'cut.ipc'), /cut off|Damaged/);
  const huge = { size: 0, async open() { this.size = 5 * 1024 ** 3; return this; }, async read() { return Buffer.alloc(8); }, async close() {} };
  const d = new ArrowDoc({ source: huge, name: 'huge.arrow' });
  await assert.rejects(d.open(), e => e.code === 'TOO_BIG' && /over 4 GB/.test(e.message));
});

test('pyarrow interop: ZSTD and LZ4 Feather, decimal, map, time, binary, int64 above 2^53', { skip: !hasPyarrow() && 'pyarrow not installed' }, async () => {
  const py = `
import pyarrow as pa, pyarrow.feather as pf, datetime, decimal, sys
t = pa.table({
 'i64': pa.array([1, 2**60, None], pa.int64()),
 'ts': pa.array([datetime.datetime(2026,1,2,3,4,5,123456), None, datetime.datetime(1999,1,1)], pa.timestamp('us', tz='UTC')),
 'd': pa.array([datetime.date(2026,1,2), None, datetime.date(2000,2,29)], pa.date32()),
 'dec': pa.array([decimal.Decimal('12.34'), None, decimal.Decimal('-0.05')], pa.decimal128(10,2)),
 'mp': pa.array([[('k',1)], None, []], pa.map_(pa.string(), pa.int64())),
 'bin': [b'\\x00\\x01', None, b'abc'],
 't32': pa.array([3600000, None, 0], pa.time32('ms')),
})
pf.write_feather(t, sys.argv[1] + '/z.feather', compression='zstd')
pf.write_feather(t, sys.argv[1] + '/l.feather', compression='lz4')
with pa.ipc.new_stream(sys.argv[1] + '/s.arrows', t.schema) as w: w.write_table(t)
`;
  execFileSync('python3', ['-c', py, T.dir], { timeout: 60000 });
  for (const f of ['z.feather', 'l.feather', 's.arrows']) {
    const d = await openFile(T.file(f));
    const r = await rows(d, 0, 3);
    assert.equal(r[0][0], 1, f);
    assert.equal(r[1][0], '1152921504606846976', f + ' big int64 as exact text');
    assert.equal(r[0][1], '2026-01-02T03:04:05.123456Z', f);
    assert.equal(r[0][2], '2026-01-02', f);
    assert.equal(r[0][3], '12.34', f);
    assert.equal(r[2][3], '-0.05', f);
    assert.deepEqual(r[0][4], { k: 1 }, f);
    assert.equal(r[0][5], '0x0001 (2 B)', f);
    assert.equal(r[0][6], '01:00:00.000', f);
    assert.equal(r[1][1], null, f);
    await d.close();
  }
});
