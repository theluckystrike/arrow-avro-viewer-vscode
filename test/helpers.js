'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { FileSource, BufferSource } = require('../src/core/source');
const { makeDoc } = require('../src/core/dataset');

/** A temp folder for one test file. Call cleanup() in after(). */
function tempDir(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `arrow-avro-viewer-${tag}-`));
  return { dir, file: name => path.join(dir, name), cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

/** Generate the sample files into dir (same script as the README screenshots). */
function makeSamples(dir) {
  execFileSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'make-samples.js'), dir], { stdio: 'ignore' });
}

async function openFile(file) {
  const d = await makeDoc(new FileSource(file), path.basename(file));
  await d.open();
  await d.whenDone;
  return d;
}

async function openBytes(bytes, name) {
  const d = await makeDoc(new BufferSource(Buffer.from(bytes)), name);
  await d.open();
  await d.whenDone;
  return d;
}

async function rows(d, from, n) {
  const out = [];
  for (let id = from; id < Math.min(d.count, from + n); id++) {
    const e = await d.getBatch(d.batchOf(id));
    out.push(d.columns.map((c, j) => d.value(e, id - e.start, j)));
  }
  return out;
}

/** A session wired to an array of posted messages. */
function harness(doc, host = {}) {
  const { createSession } = require('../src/core/protocol');
  const msgs = [];
  const waiters = [];
  const post = m => {
    msgs.push(m);
    for (const w of waiters.slice()) if (w.pred(m)) { waiters.splice(waiters.indexOf(w), 1); w.res(m); }
  };
  const session = createSession({ doc, post, host });
  const next = (pred, ms = 20000) => new Promise((res, rej) => {
    const hit = msgs.find(m => pred(m) && !m._seen);
    if (hit) { hit._seen = true; return res(hit); }
    const w = { pred: m => pred(m) && !m._seen && (m._seen = true), res };
    waiters.push(w);
    setTimeout(() => rej(new Error('timeout waiting for message')), ms).unref();
  });
  return { session, msgs, next };
}

/** An in-memory export target. */
function memWriter() {
  const w = { text: '', closed: false, label: 'out', uri: null };
  w.write = async s => { w.text += s; };
  w.close = async () => { w.closed = true; };
  return w;
}

function hasPyarrow() {
  try { execFileSync('python3', ['-c', 'import pyarrow'], { stdio: 'ignore', timeout: 20000 }); return true; } catch { return false; }
}

module.exports = { tempDir, makeSamples, openFile, openBytes, rows, harness, memWriter, hasPyarrow };
