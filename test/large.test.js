'use strict';
// Speed test on a large file made inside this test (about 40 MB) and deleted in after().
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const A = require('apache-arrow');
const { tempDir, harness } = require('./helpers');
const { makeDoc } = require('../src/core/dataset');
const { FileSource } = require('../src/core/source');

const T = tempDir('large');
const FILE = T.file('big.arrows');
const ROWS = 1500000;
const BATCH = 50000;

test.before(() => {
  const batches = [];
  for (let s = 0; s < ROWS; s += BATCH) {
    const id = new BigInt64Array(BATCH), v = new Float64Array(BATCH), code = new Array(BATCH);
    for (let i = 0; i < BATCH; i++) { id[i] = BigInt(s + i); v[i] = ((s + i) * 7919) % 100003 / 7; code[i] = 'c' + ((s + i) % 5000); }
    if (s === ROWS - BATCH) code[BATCH - 1] = 'needle-at-the-end';
    const t = new A.Table({ id: A.makeVector(id), value: A.makeVector(v), code: A.vectorFromArray(code, new A.Utf8()) });
    batches.push(...t.batches);
  }
  fs.writeFileSync(FILE, A.RecordBatchStreamWriter.writeAll(batches).toUint8Array(true));
});
test.after(() => T.cleanup());

test('large stream file: first rows fast, jump to the end, search, cancel and stats', async () => {
  const size = fs.statSync(FILE).size;
  assert.ok(size > 30e6 && size < 50e6, `fixture size ${size}`);
  const t0 = Date.now();
  const doc = await makeDoc(new FileSource(FILE), 'big.arrows');
  const h = harness(doc);
  h.session.start();
  await h.next(m => m.type === 'init');
  const tInit = Date.now() - t0;
  await h.session.handle({ type: 'getRows', reqId: 1, start: 0, count: 200 });
  await h.next(m => m.type === 'rows' && m.reqId === 1);
  const tFirst = Date.now() - t0;
  assert.ok(tFirst < 1500, `first rows after ${tFirst} ms (init ${tInit} ms)`);
  await doc.whenDone;
  assert.equal(doc.count, ROWS);
  const tIndex = Date.now() - t0;
  const t1 = Date.now();
  await h.session.handle({ type: 'getRows', reqId: 2, start: ROWS - 5, count: 5 });
  const end = await h.next(m => m.type === 'rows' && m.reqId === 2);
  assert.equal(end.rows[4].cells[2], 'needle-at-the-end');
  const tJump = Date.now() - t1;
  assert.ok(tJump < 1000, `jump to end ${tJump} ms`);

  const t2 = Date.now();
  await h.session.handle({ type: 'search', text: 'NEEDLE', col: 2 });
  const found = await h.next(m => m.type === 'job' && m.kind === 'search' && m.state === 'done');
  assert.equal(found.matches, 1);
  const tSearch = Date.now() - t2;

  const p = h.session.handle({ type: 'search', text: 'not-there', col: -1 });
  setTimeout(() => h.session.handle({ type: 'cancel' }), 100);
  await p;
  const c = await h.next(m => m.type === 'job' && m.kind === 'search' && m.state === 'cancelled');
  assert.ok(c.matches === 0);

  await h.session.handle({ type: 'clearView' });
  const t3 = Date.now();
  await h.session.handle({ type: 'stats', col: 1 });
  const st = await h.next(m => m.type === 'stats' && m.state === 'done', 60000);
  assert.equal(st.result.count, ROWS);
  const tStats = Date.now() - t3;
  console.log(`# speed: ${(size / 1e6).toFixed(1)} MB, ${ROWS} rows: init ${tInit} ms, first rows ${tFirst} ms, full index ${tIndex} ms, jump to end ${tJump} ms, search 1 column ${tSearch} ms, stats ${tStats} ms`);
  await h.session.dispose();
});
