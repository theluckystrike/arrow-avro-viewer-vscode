'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { tempDir, makeSamples, openFile, openBytes, rows } = require('./helpers');
const { parseHeader, avroTypeName, decodingSchema } = require('../src/core/avrodoc');

const T = tempDir('avro');
test.before(() => makeSamples(T.dir));
test.after(() => T.cleanup());

test('Avro deflate: header, blocks, row count and logical types', async () => {
  const d = await openFile(T.file('customers.avro'));
  assert.equal(d.codec, 'deflate');
  assert.equal(d.count, 8000);
  assert.equal(d.batches.length, 8);
  const types = Object.fromEntries(d.columns.map(c => [c.name, c.type]));
  assert.equal(types.plan, 'enum Plan');
  assert.equal(types.last_login, 'timestamp-millis?');
  assert.equal(types.balance, 'decimal(10,2)');
  assert.equal(types.tags, 'array<string>');
  assert.equal(types.address, 'record Address?');
  assert.equal(d.columns.find(c => c.name === 'last_login').nullable, true);
  assert.equal(d.columns.find(c => c.name === 'email').nullable, false);
  const [r] = await rows(d, 0, 1);
  assert.equal(r[0], 1);
  assert.match(r[3], /^\d{4}-\d\d-\d\d$/);
  assert.match(r[5], /^-?\d+\.\d\d$/);
  const [r5] = await rows(d, 5, 1);
  assert.equal(r5[1], '<script>alert(1)</script>@example.com');
  const [r3] = await rows(d, 3, 1);
  assert.equal(r3[9], '9007199254740996', 'long above 2^53 stays exact');
  const info = d.schemaInfo();
  assert.match(info.schemaText, /"Customer"/);
  assert.equal(info.metadata.writer, 'zovo make-samples.js');
  await d.close();
});

test('Avro snappy: timestamp-micros and nullable union', async () => {
  const d = await openFile(T.file('clicks-snappy.avro'));
  assert.equal(d.codec, 'snappy');
  assert.equal(d.count, 30000);
  const r = await rows(d, 0, 2);
  assert.equal(r[0][0], '2026-01-01T00:00:00.000000Z');
  assert.equal(r[1][0], '2026-01-01T00:00:01.234567Z');
  const [last] = await rows(d, 29999, 1);
  assert.equal(last.length, 6);
  await d.close();
});

test('header parser: short input returns null, other files are refused', () => {
  const buf = fs.readFileSync(T.file('customers.avro'));
  assert.equal(parseHeader(buf.subarray(0, 10)), null);
  const h = parseHeader(buf);
  assert.equal(h.sync.length, 16);
  assert.ok(h.meta['avro.schema']);
  assert.throws(() => parseHeader(Buffer.from('PAR1....')), /not an Avro object container/);
});

test('unsupported codec, damaged sync marker and cut-off files give clear messages', async () => {
  const buf = fs.readFileSync(T.file('clicks-snappy.avro'));
  const bad = Buffer.from(buf);
  const i = bad.indexOf('snappy');
  bad.write('bzip2!', i, 'latin1');
  await assert.rejects(openBytes(bad, 'x.avro'), /"bzip2!" codec/);
  const h = parseHeader(buf);
  const broken = Buffer.from(buf);
  const syncAt = broken.indexOf(h.sync, h.end); // first block's trailing sync
  broken[syncAt] ^= 0xff;
  await assert.rejects(openBytes(broken, 'x.avro'), /sync marker/);
  await assert.rejects(openBytes(buf.subarray(0, buf.length - 1000), 'cut.avro'), /cut off/);
});

test('type names and decoding schema', () => {
  assert.equal(avroTypeName(['null', 'string']), 'string?');
  assert.equal(avroTypeName({ type: 'map', values: 'long' }), 'map<long>');
  assert.equal(avroTypeName(['null', 'int', 'string']), 'union<int, string>?');
  assert.equal(avroTypeName({ type: 'fixed', size: 16, name: 'md5' }), 'fixed(16)');
  assert.deepEqual(decodingSchema({ type: 'record', name: 'r', fields: [{ name: 'a', type: { type: 'long', logicalType: 'timestamp-millis' } }] }).fields[0].type, 'long');
});
