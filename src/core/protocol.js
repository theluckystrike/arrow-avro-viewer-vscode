'use strict';
// Message protocol between the webview and the extension host, and the session that serves one open file.
// Kept free of the vscode module so it runs under plain node --test.
//
// webview -> host: ready, getRows, getCell, search, cancel, clearView, stats, export, copy, hint
// host -> webview: init, progress, rows, cell, view, job, stats, error

const L = require('./limits');
const V = require('./values');
const { ColumnStats } = require('./stats');
const { csvHeader, csvRow, jsonRow } = require('./exportfile');

const int = (v, min, max) => Number.isInteger(v) && v >= min && v <= max;
const str = (v, max) => typeof v === 'string' && v.length <= max;
const BIG = 0xffffffff;

/** Validate a message from the webview. Returns a clean copy or null. */
function validateWebviewMessage(m) {
  if (!m || typeof m !== 'object' || typeof m.type !== 'string') return null;
  switch (m.type) {
    case 'ready': case 'cancel': case 'clearView':
      return { type: m.type };
    case 'getRows':
      return int(m.reqId, 0, BIG) && int(m.start, 0, BIG) && int(m.count, 1, L.CHUNK) ? { type: m.type, reqId: m.reqId, start: m.start, count: m.count } : null;
    case 'getCell':
      return int(m.reqId, 0, BIG) && int(m.pos, 0, BIG) && int(m.col, 0, 100000) ? { type: m.type, reqId: m.reqId, pos: m.pos, col: m.col } : null;
    case 'search':
      return str(m.text, 1000) && m.text.length > 0 && int(m.col, -1, 100000) ? { type: m.type, text: m.text, col: m.col } : null;
    case 'stats':
      return int(m.col, 0, 100000) ? { type: m.type, col: m.col } : null;
    case 'export':
      if (!['csv', 'json'].includes(m.format) || !['page', 'all'].includes(m.scope)) return null;
      if (m.scope === 'page' && !int(m.start, 0, BIG)) return null;
      return { type: m.type, format: m.format, scope: m.scope, start: m.scope === 'page' ? m.start : 0 };
    case 'copy':
      return str(m.text, 10 * 1024 * 1024) ? { type: m.type, text: m.text } : null;
    case 'hint':
      return m.what === 'tableViewer' ? { type: m.type, what: m.what } : null;
    default:
      return null;
  }
}

const tick = () => new Promise(r => setImmediate(r));

function fmtBytes(n) {
  if (n < 1024) return n + ' B';
  const u = ['KB', 'MB', 'GB', 'TB'];
  let v = n, k = -1;
  do { v /= 1024; k++; } while (v >= 1024 && k < u.length - 1);
  return (v >= 100 ? v.toFixed(0) : v.toFixed(1)) + ' ' + u[k];
}

/**
 * One open file. post(msg) sends to the webview. host = {
 *   copy(text), openWriter(format, defaultName) -> {write, close, label, uri} | null,
 *   exported({format, label, uri, written}), hint(what) }
 */
function createSession({ doc, post, host = {} }) {
  const S = { doc, ready: false, error: '', view: null, viewLabel: '', viewVersion: 0, job: null, statsJob: null, disposed: false };

  const viewCount = () => (S.view ? S.view.length : S.doc.count);
  const idAt = pos => (S.view ? S.view[pos] : pos);

  function initMsg() {
    const d = S.doc;
    return {
      type: 'init', name: d.name, kind: d.kind, format: d.format, size: d.size, sizeText: fmtBytes(d.size),
      count: d.count, done: d.done, batches: d.batches.length, columns: d.columns,
      schema: d.schemaInfo(), viewCount: viewCount(), viewVersion: S.viewVersion, viewLabel: S.viewLabel,
      limits: { chunk: L.CHUNK, page: L.PAGE_ROWS, file: L.MAX_FILE_BYTES },
    };
  }

  async function start() {
    try {
      await S.doc.open({ onProgress: p => { if (S.ready && !S.disposed) post({ type: 'progress', ...p, viewCount: viewCount() }); } });
    } catch (e) {
      S.error = e.code ? e.message : 'Could not open the file: ' + e.message;
      await S.doc.close().catch(() => {});
      post({ type: 'error', fatal: true, message: S.error });
      return;
    }
    S.ready = true;
    post(initMsg());
    try { await S.doc.whenDone; } catch (e) { if (!S.disposed) post({ type: 'error', message: 'Reading stopped: ' + e.message }); }
    if (!S.disposed) post({ type: 'progress', ...S.doc.progress(), viewCount: viewCount() });
  }

  /** Visit rows by id in order. fn(entry, i, id) per row. Follows the index while it grows when ids is null. */
  async function scanRows(ids, fn, tok, onProgress) {
    const d = S.doc;
    if (ids) {
      for (let p = 0; p < ids.length;) {
        if (tok.cancelled || S.disposed) return false;
        const k = d.batchOf(ids[p]);
        const entry = await d.getBatch(k);
        const end = entry.start + entry.rows;
        let n = 0;
        while (p < ids.length && ids[p] >= entry.start && ids[p] < end) { fn(entry, ids[p] - entry.start, ids[p]); p++; if (++n % 5000 === 0) await tick(); }
        if (onProgress) await onProgress(p, ids.length);
        await tick();
      }
      return true;
    }
    for (let k = 0; ; k++) {
      while (k >= d.batches.length && !d.done && !tok.cancelled && !S.disposed) {
        await Promise.race([d.whenDone.catch(() => {}), new Promise(r => setTimeout(r, 50))]);
      }
      if (k >= d.batches.length) break;
      if (tok.cancelled || S.disposed) return false;
      const entry = await d.getBatch(k);
      for (let i = 0; i < entry.rows; i++) {
        fn(entry, i, entry.start + i);
        if (i % 5000 === 4999) { await tick(); if (tok.cancelled || S.disposed) return false; }
      }
      if (onProgress) await onProgress(entry.start + entry.rows, d.count);
      await tick();
    }
    return true;
  }

  function setView(view, label) {
    S.view = view;
    S.viewLabel = label;
    S.viewVersion++;
    post({ type: 'view', count: viewCount(), version: S.viewVersion, label });
  }

  function cancelJob() { if (S.job) S.job.cancelled = true; }

  async function search(text, col) {
    cancelJob();
    const tok = { cancelled: false };
    S.job = tok;
    const q = text.toLowerCase();
    const cols = col >= 0 ? [col] : S.doc.columns.map((c, i) => i);
    let out = new Uint32Array(1024), n = 0, last = 0, full = false;
    const t0 = Date.now();
    let ok;
    try {
      ok = await scanRows(null, (entry, i, id) => {
        for (const c of cols) {
          const v = S.doc.value(entry, i, c);
          if (v === null) continue;
          const s = typeof v === 'string' ? v : JSON.stringify(v);
          if (s.toLowerCase().includes(q)) {
            if (n === out.length) { if (n >= L.MAX_VIEW) { full = true; tok.cancelled = true; return; } const g = new Uint32Array(Math.min(L.MAX_VIEW, n * 2)); g.set(out); out = g; }
            out[n++] = id;
            return;
          }
        }
      }, tok, (done, total) => {
        const now = Date.now();
        if (now - last > 150) { last = now; post({ type: 'job', kind: 'search', state: 'running', done, total, matches: n }); }
      });
    } catch (e) {
      if (S.job === tok) S.job = null;
      post({ type: 'job', kind: 'search', state: 'error', message: e.message });
      return;
    }
    if (S.disposed) return;
    if (S.job === tok) S.job = null;
    else if (!ok) return; // a newer job replaced this one
    const where = col >= 0 ? ` in ${S.doc.columns[col].name}` : '';
    const label = `"${text}"${where}` + (full ? ` (first ${n.toLocaleString('en-US')} matches)` : ok ? '' : ' (stopped early)');
    setView(out.slice(0, n), label);
    post({ type: 'job', kind: 'search', state: ok || full ? 'done' : 'cancelled', matches: n, total: S.doc.count, ms: Date.now() - t0 });
  }

  async function stats(col) {
    if (S.statsJob) S.statsJob.cancelled = true;
    const tok = { cancelled: false, col };
    S.statsJob = tok;
    const st = new ColumnStats(L.STATS_DISTINCT);
    let last = Date.now();
    const ids = S.view;
    let ok;
    try {
      ok = await scanRows(ids, (entry, i) => st.add(S.doc.raw(entry, i, col)), tok, (done, total) => {
        const now = Date.now();
        if (now - last > 250) { last = now; post({ type: 'stats', col, state: 'running', done, total, result: st.result() }); }
      });
    } catch (e) {
      post({ type: 'stats', col, state: 'error', message: e.message });
      return;
    }
    if (S.statsJob === tok) S.statsJob = null;
    if (S.disposed) return;
    post({ type: 'stats', col, state: ok ? 'done' : 'cancelled', scope: ids ? S.viewLabel : 'all rows', result: st.result() });
  }

  async function getRows(m) {
    const end = Math.min(viewCount(), m.start + m.count);
    const version = S.viewVersion;
    const rows = [];
    try {
      for (let p = m.start; p < end; p++) {
        const id = idAt(p);
        const k = S.doc.batchOf(id);
        const entry = await S.doc.getBatch(k);
        const i = id - entry.start;
        const cells = new Array(S.doc.columns.length);
        for (let c = 0; c < cells.length; c++) cells[c] = V.cellText(S.doc.value(entry, i, c), L.CELL_CHARS);
        rows.push({ n: id + 1, cells });
      }
    } catch (e) {
      post({ type: 'rows', reqId: m.reqId, version, start: m.start, rows: [], error: e.message });
      return;
    }
    post({ type: 'rows', reqId: m.reqId, version, start: m.start, rows });
  }

  async function getCell(m) {
    if (m.pos >= viewCount() || m.col >= S.doc.columns.length) return;
    const id = idAt(m.pos);
    const entry = await S.doc.getBatch(S.doc.batchOf(id));
    const v = S.doc.value(entry, id - entry.start, m.col);
    let text = v === null ? 'null' : typeof v === 'string' ? v : V.jsonText(v, 2);
    const cut = text.length > L.VALUE_CHARS;
    if (cut) text = text.slice(0, L.VALUE_CHARS);
    post({ type: 'cell', reqId: m.reqId, pos: m.pos, col: m.col, row: id + 1, text, json: v !== null && typeof v === 'object', cut });
  }

  async function doExport(m) {
    if (!host.openWriter) return;
    const base = S.doc.name.replace(/\.(arrow|arrows|feather|ipc|avro)$/i, '');
    const total = viewCount();
    const from = m.scope === 'page' ? Math.min(m.start, total) : 0;
    const to = m.scope === 'page' ? Math.min(total, from + L.PAGE_ROWS) : total;
    const suffix = m.scope === 'page' ? `-rows-${from + 1}-${to}` : S.view ? '-matches' : '';
    const w = await host.openWriter(m.format, `${base}${suffix}.${m.format}`);
    if (!w) return;
    cancelJob();
    if (!S.doc.done) await S.doc.whenDone.catch(() => {});
    const tok = { cancelled: false };
    S.job = tok;
    const cols = S.doc.columns;
    const ids = new Uint32Array(Math.max(0, to - from));
    for (let p = from; p < to; p++) ids[p - from] = idAt(p);
    let buf = m.format === 'csv' ? csvHeader(cols) : '[\n';
    let written = 0, last = 0;
    try {
      let pending = Promise.resolve();
      const ok = await scanRows(ids, (entry, i) => {
        const vals = cols.map((c, j) => S.doc.value(entry, i, j));
        if (m.format === 'csv') buf += csvRow(vals);
        else buf += (written ? ',\n  ' : '  ') + jsonRow(cols, vals);
        written++;
      }, tok, async (done) => {
        if (buf.length > 1024 * 1024) { const s = buf; buf = ''; pending = pending.then(() => w.write(s)); await pending; }
        const now = Date.now();
        if (now - last > 200) { last = now; post({ type: 'job', kind: 'export', state: 'running', done, total: ids.length }); }
      });
      await pending;
      if (m.format === 'json') buf += written ? '\n]\n' : ']\n';
      if (buf) await w.write(buf);
      await w.close();
      if (S.job === tok) S.job = null;
      if (!ok) { post({ type: 'job', kind: 'export', state: 'cancelled', written }); return; }
      post({ type: 'job', kind: 'export', state: 'done', written, total: ids.length });
      if (host.exported) host.exported({ format: m.format, label: w.label, uri: w.uri, written });
    } catch (e) {
      if (S.job === tok) S.job = null;
      post({ type: 'job', kind: 'export', state: 'error', message: 'Export failed: ' + e.message });
    }
  }

  async function handle(raw) {
    const m = validateWebviewMessage(raw);
    if (!m || S.disposed) return;
    if (m.type === 'ready') { if (S.ready) post(initMsg()); else if (S.error) post({ type: 'error', fatal: true, message: S.error }); return; }
    if (!S.ready) return;
    try {
      switch (m.type) {
        case 'getRows': return await getRows(m);
        case 'getCell': return await getCell(m);
        case 'search': return await search(m.text, m.col < S.doc.columns.length ? m.col : -1);
        case 'cancel': cancelJob(); if (S.statsJob) S.statsJob.cancelled = true; return;
        case 'clearView': cancelJob(); return setView(null, '');
        case 'stats': if (m.col < S.doc.columns.length) await stats(m.col); return;
        case 'export': return await doExport(m);
        case 'copy': if (host.copy) await host.copy(m.text); return;
        case 'hint': if (host.hint) await host.hint(m.what); return;
      }
    } catch (e) {
      post({ type: 'error', message: e.message });
    }
  }

  async function dispose() {
    S.disposed = true;
    cancelJob();
    if (S.statsJob) S.statsJob.cancelled = true;
    await S.doc.close();
  }

  return { start, handle, dispose, state: S };
}

module.exports = { validateWebviewMessage, createSession, fmtBytes };
