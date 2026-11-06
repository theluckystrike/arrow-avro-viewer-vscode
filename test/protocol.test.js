'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { tempDir, makeSamples, harness, memWriter } = require('./helpers');
const { validateWebviewMessage } = require('../src/core/protocol');
const { makeDoc } = require('../src/core/dataset');
const { FileSource, BufferSource } = require('../src/core/source');
const { csvField } = require('../src/core/exportfile');
const { ColumnStats } = require('../src/core/stats');

const T = tempDir('proto');
test.before(() => makeSamples(T.dir));
test.after(() => T.cleanup());

async function open(name, host) {
  const doc = await makeDoc(new FileSource(T.file(name)), name);
  const h = harness(doc, host);
  h.session.start();
  const init = await h.next(m => m.type === 'init');
  await doc.whenDone;
  return { ...h, doc, init };
}

test('message validation drops unknown or out-of-range messages', () => {
  assert.equal(validateWebviewMessage(null), null);
  assert.equal(validateWebviewMessage({ type: 'writeFile', path: '/etc/passwd' }), null);
  assert.equal(validateWebviewMessage({ type: 'getRows', reqId: 1, start: 0, count: 10000 }), null, 'chunk limit');
  assert.equal(validateWebviewMessage({ type: 'getRows', reqId: 1, start: -1, count: 10 }), null);
  assert.deepEqual(validateWebviewMessage({ type: 'getRows', reqId: 1, start: 0, count: 200, extra: 1 }), { type: 'getRows', reqId: 1, start: 0, count: 200 });
  assert.equal(validateWebviewMessage({ type: 'search', text: '', col: -1 }), null);
  assert.equal(validateWebviewMessage({ type: 'search', text: 'x'.repeat(1001), col: -1 }), null);
  assert.equal(validateWebviewMessage({ type: 'export', format: 'xml', scope: 'all' }), null);
  assert.equal(validateWebviewMessage({ type: 'export', format: 'csv', scope: 'page' }), null, 'page needs start');
  assert.deepEqual(validateWebviewMessage({ type: 'export', format: 'json', scope: 'all', start: 5 }), { type: 'export', format: 'json', scope: 'all', start: 0 });
  assert.equal(validateWebviewMessage({ type: 'hint', what: 'other' }), null);
  assert.deepEqual(validateWebviewMessage({ type: 'cancel', x: 1 }), { type: 'cancel' });
});

test('init carries schema, row count and limits; rows come as text cells', async () => {
  const { session, next, init } = await open('taxi-trips.arrow');
  assert.equal(init.count, 60000);
  assert.equal(init.kind, 'arrow');
  assert.equal(init.columns.length, 10);
  assert.equal(init.schema.fields[0].name, 'trip_id');
  assert.equal(init.limits.page, 1000);
  await session.handle({ type: 'getRows', reqId: 7, start: 9990, count: 20 });
  const r = await next(m => m.type === 'rows' && m.reqId === 7);
  assert.equal(r.rows.length, 20);
  assert.equal(r.rows[0].n, 9991);
  assert.equal(r.rows[10].cells[0], '110000', 'crosses into the next batch');
  assert.ok(r.rows.every(x => x.cells.length === 10));
  await session.handle({ type: 'getCell', reqId: 8, pos: 7, col: 9 });
  const c = await next(m => m.type === 'cell');
  assert.equal(c.text, '<b>not html</b> & "quotes"');
  assert.equal(c.row, 8);
  await session.dispose();
});

test('search builds a view of matches; rows then come from the view', async () => {
  const { session, next } = await open('customers.avro');
  await session.handle({ type: 'search', text: 'BUSINESS', col: 2 });
  const v = await next(m => m.type === 'view');
  const done = await next(m => m.type === 'job' && m.kind === 'search' && m.state !== 'running');
  assert.equal(done.state, 'done');
  assert.ok(v.count > 1000 && v.count < 4000, String(v.count));
  assert.match(v.label, /"BUSINESS" in plan/);
  await session.handle({ type: 'getRows', reqId: 3, start: 0, count: 50 });
  const r = await next(m => m.type === 'rows' && m.reqId === 3);
  assert.ok(r.rows.every(x => x.cells[2] === 'BUSINESS'));
  await session.handle({ type: 'clearView' });
  const all = await next(m => m.type === 'view' && !m.label);
  assert.equal(all.count, 8000);
  await session.dispose();
});

test('search can be cancelled and reports what it found so far', async () => {
  const { session, next } = await open('clicks-snappy.avro');
  const p = session.handle({ type: 'search', text: 'zzz-not-there', col: -1 });
  await session.handle({ type: 'cancel' });
  await p;
  const j = await next(m => m.type === 'job' && m.kind === 'search' && m.state !== 'running');
  assert.equal(j.state, 'cancelled');
  await session.dispose();
});

test('column stats: numbers, strings and nulls', async () => {
  const { session, next } = await open('taxi-trips.arrow');
  await session.handle({ type: 'stats', col: 5 });
  const s = await next(m => m.type === 'stats' && m.state === 'done');
  assert.equal(s.result.count, 60000);
  assert.ok(s.result.min > 3 && s.result.max < 70 && s.result.mean > 5);
  await session.handle({ type: 'stats', col: 2 });
  const v = await next(m => m.type === 'stats' && m.col === 2 && m.state === 'done');
  assert.equal(v.result.distinct, 4);
  assert.equal(v.result.top.length, 4);
  await session.handle({ type: 'stats', col: 3 });
  const n = await next(m => m.type === 'stats' && m.col === 3 && m.state === 'done');
  assert.ok(n.result.nulls > 0);
  await session.handle({ type: 'stats', col: 0 });
  const id = await next(m => m.type === 'stats' && m.col === 0 && m.state === 'done');
  assert.equal(id.result.min, 100000);
  assert.equal(id.result.max, 159999);
  await session.dispose();
});

test('export: this page as CSV and all matches as JSON', async () => {
  const writers = [];
  const exported = [];
  const host = { openWriter: async (format, name) => { const w = memWriter(); w.name = name; writers.push(w); return w; }, exported: x => exported.push(x) };
  const { session, next } = await open('customers.avro', host);
  await session.handle({ type: 'export', format: 'csv', scope: 'page', start: 1000 });
  await next(m => m.type === 'job' && m.kind === 'export' && m.state === 'done');
  const csv = writers[0].text.trim().split('\r\n');
  assert.equal(writers[0].name, 'customers-rows-1001-2000.csv');
  assert.equal(csv.length, 1001);
  assert.match(csv[0], /^id,email,plan,signup_date/);
  assert.match(csv[1], /^1001,/);
  assert.ok(writers[0].closed);
  await session.handle({ type: 'search', text: 'Graz', col: -1 });
  await next(m => m.type === 'job' && m.kind === 'search' && m.state === 'done');
  await session.handle({ type: 'export', format: 'json', scope: 'all', start: 0 });
  const j = await next(m => m.type === 'job' && m.kind === 'export' && m.state === 'done');
  const arr = JSON.parse(writers[1].text);
  assert.equal(writers[1].name, 'customers-matches.json');
  assert.equal(arr.length, j.written);
  assert.ok(arr.every(o => o.address && o.address.city === 'Graz'));
  assert.equal(exported.length, 2);
  await session.dispose();
});

test('a damaged file gives one fatal error, also after a webview reload', async () => {
  const doc = await makeDoc(new BufferSource(Buffer.from('Obj\x01garbage')), 'bad.avro');
  const h = harness(doc);
  await h.session.start();
  const e = await h.next(m => m.type === 'error');
  assert.equal(e.fatal, true);
  await h.session.handle({ type: 'ready' });
  const again = await h.next(m => m.type === 'error');
  assert.equal(again.message, e.message);
});

test('CSV quoting and stats helpers', () => {
  assert.equal(csvField('a,b'), '"a,b"');
  assert.equal(csvField('say "hi"'), '"say ""hi"""');
  assert.equal(csvField(null), '');
  assert.equal(csvField({ a: 1 }), '"{""a"":1}"');
  const s = new ColumnStats(2);
  for (const v of ['a', 'b', 'c', null]) s.add(v);
  const r = s.result();
  assert.equal(r.distinct, null);
  assert.equal(r.distinctAtLeast, 2);
  assert.equal(r.nulls, 1);
  const b = new ColumnStats();
  b.add(5n); b.add(2n ** 60n); b.add(1);
  assert.equal(b.result().max, String(2n ** 60n));
  assert.equal(b.result().min, 1);
});
