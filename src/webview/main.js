'use strict';
/* global acquireVsCodeApi */
// Avro / Arrow / Feather viewer webview. File content goes into the DOM through textContent only.
const M = require('./math');

const vscode = acquireVsCodeApi();
const saved = vscode.getState() || {};
const ROW_H = 24;
const HEAD_H = 40;
const MAX_COLS = 500;

const S = {
  name: document.getElementById('app').dataset.title || '',
  columns: [], widths: [], count: 0, total: 0, version: 0,
  cache: new Map(), pending: new Set(), reqId: 1, chunk: 200, pageRows: 1000,
  mode: saved.mode || 'table', focus: -1, focusCol: -1, done: false, label: '',
  gutterW: 64, fatal: '', job: null, info: null, schema: null, statsCol: -1,
};

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined && text !== null) e.textContent = String(text);
  return e;
}
function btn(text, title, cls) { const b = el('button', 'btn' + (cls ? ' ' + cls : ''), text); if (title) b.title = title; return b; }
function fmtN(n) { return Number(n).toLocaleString('en-US'); }
function fmtMs(ms) { return ms < 1000 ? `${Math.max(1, Math.round(ms))} ms` : `${(ms / 1000).toFixed(2)} s`; }
function fmtNum(v) {
  if (typeof v !== 'number') return String(v);
  if (Number.isInteger(v)) return fmtN(v);
  const a = Math.abs(v);
  return a !== 0 && (a < 0.001 || a >= 1e12) ? v.toExponential(4) : Number(v.toFixed(4)).toLocaleString('en-US', { maximumFractionDigits: 4 });
}
function post(m) { vscode.postMessage(m); }
function saveState() { vscode.setState({ mode: S.mode }); }

// ---------- layout ----------
const app = document.getElementById('app');
const toolbar = el('div', 'toolbar');
const title = el('span', 'title', S.name);
const fmtBadge = el('span', 'fmt');
const stats = el('span', 'stats');
const tabs = el('div', 'tabs');
tabs.setAttribute('role', 'tablist');
const tabTable = btn('Table', 'Rows and columns', 'tab');
const tabSchema = btn('Schema', 'Columns, types, nullability and file details', 'tab');
tabs.append(tabTable, tabSchema);
const hintBtn = btn('Parquet or CSV?', 'Parquet, CSV and Excel files open in Table Viewer by Zovo', 'link hint');
toolbar.append(title, fmtBadge, stats, el('span', 'spacer'), hintBtn, tabs);

const findbar = el('div', 'findbar');
const search = el('input', 'search');
search.type = 'search';
search.placeholder = 'Find text in any cell';
search.setAttribute('aria-label', 'Find text');
search.spellcheck = false;
const colSel = el('select', 'colsel');
colSel.setAttribute('aria-label', 'Column to search');
const btnRun = btn('Find', 'Search every row (Enter)', 'primary');
const btnCancel = btn('Cancel', 'Stop the search');
btnCancel.hidden = true;
const jobText = el('span', 'jobtext');
const pager = el('span', 'pager');
const btnPrev = btn('◀', 'Previous page');
const pageText = el('span', 'pagetext');
const btnNext = btn('▶', 'Next page');
pager.append(btnPrev, pageText, btnNext);
const rowInput = el('input', 'rowinput');
rowInput.placeholder = 'Row #';
rowInput.setAttribute('aria-label', 'Go to row');
rowInput.inputMode = 'numeric';
const exportSel = el('select', 'export');
exportSel.setAttribute('aria-label', 'Export');
for (const [v, t] of [['', 'Export…'], ['page:csv', 'This page as CSV'], ['page:json', 'This page as JSON'], ['all:csv', 'All rows as CSV'], ['all:json', 'All rows as JSON']]) { const o = el('option', null, t); o.value = v; exportSel.append(o); }
exportSel.title = 'Save rows to a file. After Find, "All rows" means all matches.';
findbar.append(search, colSel, btnRun, btnCancel, jobText, el('span', 'spacer'), pager, rowInput, exportSel);

const banner = el('div', 'banner');
banner.hidden = true;
const bannerText = el('span', 'btext');
const bannerAct = btn('Show all rows', 'Clear the search', 'link');
banner.append(bannerText, bannerAct);

const main = el('div', 'main');
const grid = el('div', 'grid');
grid.tabIndex = 0;
grid.setAttribute('role', 'grid');
const sizer = el('div', 'sizer');
const stage = el('div', 'stage');
const head = el('div', 'head');
const body = el('div', 'body');
stage.append(head, body);
sizer.append(stage);
grid.append(sizer);
const drawer = el('div', 'drawer');
drawer.hidden = true;
const drawerBar = el('div', 'navbar');
const drawerTitle = el('span', 'navtitle');
const drawerStop = btn('Cancel', 'Stop computing stats');
drawerStop.hidden = true;
const drawerCopy = btn('Copy', 'Copy this value');
const drawerClose = btn('Close', 'Close (Esc)');
drawerBar.append(drawerTitle, el('span', 'spacer'), drawerStop, drawerCopy, drawerClose);
const drawerBody = el('div', 'dbody');
drawer.append(drawerBar, drawerBody);
const tablePane = el('div', 'pane tablepane');
tablePane.append(grid, drawer);
const schemaPane = el('div', 'pane schemapane');
const fatalBox = el('div', 'fatal');
fatalBox.hidden = true;
main.append(tablePane, schemaPane, fatalBox);

const status = el('div', 'status');
const statusLeft = el('span', 'left');
const statusMid = el('span', 'mid');
const statusRight = el('span', 'right', 'Click a header for column stats · click a cell for its full value');
status.append(statusLeft, statusMid, statusRight);
const toast = el('div', 'toast');
toast.hidden = true;
app.append(toolbar, findbar, banner, main, status, toast);

let toastTimer = null;
function flash(text) {
  toast.textContent = text;
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.hidden = true; }, 2200);
}

// ---------- modes ----------
function setMode(mode) {
  S.mode = mode;
  tabTable.classList.toggle('on', mode === 'table');
  tabSchema.classList.toggle('on', mode === 'schema');
  tabTable.setAttribute('aria-selected', String(mode === 'table'));
  tabSchema.setAttribute('aria-selected', String(mode === 'schema'));
  tablePane.hidden = mode !== 'table' || !!S.fatal;
  schemaPane.hidden = mode !== 'schema' || !!S.fatal;
  findbar.hidden = !!S.fatal;
  saveState();
  if (mode === 'table') { layout(); grid.focus(); } else renderSchema();
}
tabTable.addEventListener('click', () => setMode('table'));
tabSchema.addEventListener('click', () => setMode('schema'));
hintBtn.addEventListener('click', () => post({ type: 'hint', what: 'tableViewer' }));

// ---------- header ----------
function totalWidth() { return S.gutterW + S.widths.reduce((a, b) => a + b, 0); }
function shownCols() { return Math.min(S.columns.length, MAX_COLS); }
function shortType(t) { return t.length > 28 ? t.slice(0, 27) + '…' : t; }

function buildHeader() {
  head.textContent = '';
  head.append(el('div', 'cell gutter corner', 'row'));
  for (let c = 0; c < shownCols(); c++) {
    const col = S.columns[c];
    const h = el('div', 'cell hcell' + (c === S.statsCol && !drawer.hidden ? ' on' : ''));
    h.style.width = S.widths[c] + 'px';
    const top = el('div', 'hrow');
    top.append(el('span', 'hname', col.name));
    const sub = el('div', 'hsub');
    sub.append(el('span', 'htype k-' + col.kind, shortType(col.type)));
    if (!col.nullable) sub.append(el('span', 'hnn', 'not null'));
    h.append(top, sub);
    h.title = `${col.name}\n${col.type}${col.nullable ? ' (nullable)' : ' (not null)'}${col.doc ? '\n' + col.doc : ''}\nClick for column stats`;
    h.addEventListener('click', () => openStats(c));
    head.append(h);
  }
  head.style.width = totalWidth() + 'px';
}

function setColumns(columns) {
  S.columns = columns || [];
  S.widths = S.columns.slice(0, MAX_COLS).map(c => M.autoWidth(c.name, shortType(c.type), []));
  S.autoSized = false;
  colSel.textContent = '';
  const all = el('option', null, 'All columns');
  all.value = '-1';
  colSel.append(all);
  S.columns.forEach((c, i) => { const o = el('option', null, c.name); o.value = String(i); colSel.append(o); });
  buildHeader();
}

function autoSize(rows) {
  if (S.autoSized || !rows.length) return;
  S.autoSized = true;
  for (let c = 0; c < shownCols(); c++) {
    const samples = [];
    for (const r of rows) if (typeof r.cells[c] === 'string') samples.push(r.cells[c].slice(0, 60));
    S.widths[c] = M.autoWidth(S.columns[c].name, shortType(S.columns[c].type), samples);
  }
  buildHeader();
  layout();
}

// ---------- body ----------
const rowPool = [];
let rafPending = false;
function schedule() {
  if (rafPending) return;
  rafPending = true;
  requestAnimationFrame(() => { rafPending = false; render(); });
}

function layout() {
  S.gutterW = M.gutterWidth(Math.max(S.total, 1) * 1.1);
  document.documentElement.style.setProperty('--gutter-w', S.gutterW + 'px');
  const bodyH = Math.min(S.count * ROW_H, M.MAX_BODY_PX);
  sizer.style.height = (HEAD_H + bodyH) + 'px';
  const w = totalWidth();
  sizer.style.width = w + 'px';
  stage.style.width = w + 'px';
  head.style.width = w + 'px';
  render();
}

function viewportBodyH() { return Math.max(0, grid.clientHeight - HEAD_H); }

function visibleRange() {
  const vh = viewportBodyH();
  const { first, shift } = M.scrollToRow(grid.scrollTop, S.count, ROW_H, vh);
  const count = Math.ceil((vh + shift) / ROW_H) + 1;
  return { first, last: Math.min(S.count - 1, first + count - 1), shift };
}

function makeRow() {
  const r = el('div', 'row');
  r._g = el('div', 'cell gutter');
  r.append(r._g);
  r._cells = [];
  return r;
}

function fillCells(r, n) {
  while (r._cells.length < n) { const d = el('div', 'cell'); r.append(d); r._cells.push(d); }
  while (r._cells.length > n) r._cells.pop().remove();
}

function render() {
  if (S.mode !== 'table' || S.fatal) return;
  stage.style.height = Math.min(grid.clientHeight, HEAD_H + Math.min(S.count * ROW_H, M.MAX_BODY_PX)) + 'px';
  const { first, last, shift } = visibleRange();
  const n = S.count ? Math.max(0, last - first + 1) : 0;
  while (rowPool.length < n) { const r = makeRow(); rowPool.push(r); body.append(r); }
  body.style.transform = `translateY(${-shift}px)`;
  const cols = shownCols();
  const missing = [];
  for (let k = 0; k < rowPool.length; k++) {
    const r = rowPool[k];
    if (k >= n) { r.hidden = true; continue; }
    r.hidden = false;
    const pos = first + k;
    r._pos = pos;
    const page = S.cache.get(Math.floor(pos / S.chunk));
    const row = page ? page[pos % S.chunk] : undefined;
    r.classList.toggle('focus', pos === S.focus);
    r._g.textContent = row ? fmtN(row.n) : '';
    fillCells(r, cols);
    for (let c = 0; c < cols; c++) {
      const d = r._cells[c];
      d._c = c;
      d.style.width = S.widths[c] + 'px';
      if (!row) { d.className = 'cell pending'; d.textContent = ''; continue; }
      const v = row.cells[c];
      const kind = S.columns[c].kind;
      d.className = 'cell k-' + (v === null ? 'null' : kind) + (pos === S.focus && c === S.focusCol ? ' sel' : '');
      d.textContent = v === null ? '' : v;
    }
    if (!row) missing.push(pos);
  }
  if (missing.length) request(missing[0], missing[missing.length - 1]);
  updateStatus();
}

function request(first, last) {
  for (const p of M.pagesFor(first, last, S.chunk)) {
    const key = S.version + ':' + p;
    if (S.cache.has(p) || S.pending.has(key)) continue;
    S.pending.add(key);
    post({ type: 'getRows', reqId: S.reqId++, start: p * S.chunk, count: S.chunk });
  }
}

grid.addEventListener('scroll', schedule);
window.addEventListener('resize', schedule);

function scrollToPos(pos) {
  const vh = viewportBodyH();
  grid.scrollTop = M.rowToScroll(Math.max(0, pos), S.count, ROW_H, vh);
  schedule();
}

function ensureVisible(pos) {
  const vh = viewportBodyH();
  const { first, last } = visibleRange();
  if (pos <= first || pos >= last) grid.scrollTop = M.rowToScroll(Math.max(0, pos - Math.floor(vh / ROW_H / 2)), S.count, ROW_H, vh);
}

function setFocus(pos, col, scroll) {
  if (!S.count) { S.focus = -1; return; }
  S.focus = Math.max(0, Math.min(S.count - 1, pos));
  if (col !== undefined) S.focusCol = col;
  if (scroll) ensureVisible(S.focus);
  render();
}

body.addEventListener('mousedown', e => {
  const rowEl = e.target.closest && e.target.closest('.row');
  if (!rowEl || rowEl._pos === undefined) return;
  grid.focus();
  const cell = e.target.closest('.cell');
  const c = cell && cell._c !== undefined && !cell.classList.contains('gutter') ? cell._c : -1;
  setFocus(rowEl._pos, c, false);
  if (c >= 0) openCell(rowEl._pos, c);
});

grid.addEventListener('keydown', e => {
  const moves = { ArrowUp: -1, ArrowDown: 1, PageUp: -20, PageDown: 20 };
  if (e.key === 'Home') { e.preventDefault(); return setFocus(0, undefined, true); }
  if (e.key === 'End') { e.preventDefault(); return setFocus(S.count - 1, undefined, true); }
  if (e.key === 'Escape') { closeDrawer(); return; }
  if (e.key === 'Enter' && S.focus >= 0 && S.focusCol >= 0) { e.preventDefault(); return openCell(S.focus, S.focusCol); }
  if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
    if (S.focus < 0) return;
    e.preventDefault();
    const c = Math.max(0, Math.min(shownCols() - 1, (S.focusCol < 0 ? 0 : S.focusCol) + (e.key === 'ArrowLeft' ? -1 : 1)));
    return setFocus(S.focus, c, false);
  }
  const m = moves[e.key];
  if (!m) return;
  e.preventDefault();
  setFocus(S.focus < 0 ? 0 : S.focus + m, undefined, true);
});

// ---------- drawer: one cell or column stats ----------
let drawerCopyText = '';
const cellWaiters = new Map();
function openCell(pos, c) {
  const reqId = S.reqId++;
  cellWaiters.set(reqId, { version: S.version });
  post({ type: 'getCell', reqId, pos, col: c });
}
function onCell(m) {
  const w = cellWaiters.get(m.reqId);
  cellWaiters.delete(m.reqId);
  if (!w || w.version !== S.version) return;
  S.statsCol = -1;
  drawer.hidden = false;
  drawerStop.hidden = true;
  drawerCopy.hidden = false;
  drawerTitle.textContent = `Row ${fmtN(m.row)} · ${S.columns[m.col].name} · ${S.columns[m.col].type}`;
  drawerBody.textContent = '';
  const pre = el('pre', 'value' + (m.json ? ' json' : ''), m.text);
  drawerBody.append(pre);
  if (m.cut) drawerBody.append(el('div', 'note', 'Long value: the first 200,000 characters are shown.'));
  drawerCopyText = m.text;
  buildHeader();
  render();
}
function closeDrawer() {
  if (S.statsCol >= 0) post({ type: 'cancel' });
  drawer.hidden = true;
  S.statsCol = -1;
  buildHeader();
  render();
}
drawerClose.addEventListener('click', closeDrawer);
drawerCopy.addEventListener('click', () => { post({ type: 'copy', text: drawerCopyText }); flash('Copied'); });
drawerStop.addEventListener('click', () => post({ type: 'cancel' }));

function openStats(c) {
  S.statsCol = c;
  drawer.hidden = false;
  drawerStop.hidden = false;
  drawerCopy.hidden = true;
  drawerTitle.textContent = `Stats · ${S.columns[c].name} · ${S.columns[c].type}`;
  drawerBody.textContent = '';
  drawerBody.append(el('div', 'note', 'Reading the column…'));
  buildHeader();
  render();
  post({ type: 'stats', col: c });
}

function statLine(dl, k, v) { dl.append(el('dt', null, k), el('dd', null, v)); }

function onStats(m) {
  if (m.col !== S.statsCol || drawer.hidden) return;
  const r = m.result;
  drawerStop.hidden = m.state !== 'running';
  drawerBody.textContent = '';
  if (m.state === 'error') { drawerBody.append(el('div', 'note bad', m.message)); return; }
  const head2 = m.state === 'running' ? `Reading… ${fmtN(m.done)} of ${fmtN(m.total)} rows` : m.state === 'cancelled' ? `Stopped after ${fmtN(r.count)} rows` : `All ${fmtN(r.count)} rows${m.scope && m.scope !== 'all rows' ? ' matching ' + m.scope : ''}`;
  drawerBody.append(el('div', 'note', head2));
  const wrap = el('div', 'statwrap');
  const dl = el('dl', 'stats');
  statLine(dl, 'Values', fmtN(r.nonNull));
  statLine(dl, 'Nulls', `${fmtN(r.nulls)}${r.count ? ` (${(100 * r.nulls / r.count).toFixed(1)}%)` : ''}`);
  statLine(dl, 'Distinct', r.distinct === null ? `more than ${fmtN(r.distinctAtLeast)}` : fmtN(r.distinct));
  if (r.min !== undefined) statLine(dl, 'Min', typeof r.min === 'number' ? fmtNum(r.min) : String(r.min));
  if (r.max !== undefined) statLine(dl, 'Max', typeof r.max === 'number' ? fmtNum(r.max) : String(r.max));
  if (r.mean !== undefined) { statLine(dl, 'Mean', fmtNum(r.mean)); statLine(dl, 'Std dev', fmtNum(r.std)); }
  if (r.lenMax !== undefined) statLine(dl, 'Length', `${fmtN(r.lenMin)} to ${fmtN(r.lenMax)} chars`);
  if (r.trues !== undefined) statLine(dl, 'true / false', `${fmtN(r.trues)} / ${fmtN(r.falses)}`);
  wrap.append(dl);
  if (r.top && r.top.length) {
    const top = el('div', 'top');
    top.append(el('div', 'toptitle', 'Most common'));
    const max = r.top[0].n;
    for (const t of r.top) {
      const line = el('div', 'topline');
      const bar = el('span', 'bar');
      bar.style.width = Math.max(2, Math.round(120 * t.n / max)) + 'px';
      line.append(el('span', 'topv', t.value), bar, el('span', 'topn', fmtN(t.n)));
      top.append(line);
    }
    wrap.append(top);
  }
  drawerBody.append(wrap);
}

// ---------- schema tab ----------
function renderSchema() {
  schemaPane.textContent = '';
  const sc = S.schema;
  if (!sc) return;
  const box = el('div', 'schemabox');
  const facts = el('dl', 'facts');
  const fact = (k, v) => { if (v !== undefined && v !== null && v !== '') facts.append(el('dt', null, k), el('dd', null, v)); };
  fact('Format', sc.format + (sc.version ? ` (metadata ${sc.version})` : ''));
  fact('Rows', fmtN(S.total) + (S.done ? '' : ' so far'));
  fact('Columns', fmtN(sc.fields.length));
  fact(sc.kind === 'avro' ? 'Blocks' : 'Record batches', fmtN(S.info.batches));
  fact(sc.kind === 'avro' ? 'Codec' : 'Compression', sc.kind === 'avro' ? sc.codec : sc.compression);
  if (sc.kind === 'arrow') fact('Dictionaries', fmtN(sc.dictionaries));
  fact('Size', S.info.sizeText);
  box.append(facts);
  const table = el('table', 'fields');
  const hr = el('tr');
  for (const h of ['#', 'Name', 'Type', 'Nullable', 'Details']) hr.append(el('th', null, h));
  table.append(hr);
  const addRow = (f, i, depth) => {
    const tr = el('tr');
    tr.append(el('td', 'num', depth ? '' : i + 1));
    const nm = el('td', 'fname', f.name);
    nm.style.paddingLeft = (8 + depth * 18) + 'px';
    tr.append(nm, el('td', 'ftype k-' + (f.kind || 'nested'), f.type), el('td', null, f.nullable ? 'yes' : 'no'));
    const det = [];
    if (f.doc) det.push(f.doc);
    if (f.default !== undefined) det.push('default ' + JSON.stringify(f.default));
    if (f.meta) det.push(Object.entries(f.meta).map(([k, v]) => `${k}=${String(v).slice(0, 80)}`).join(', '));
    tr.append(el('td', 'fdet', det.join(' · ')));
    table.append(tr);
    if (f.tree && f.tree.children) for (const ch of f.tree.children) addRow({ ...ch, tree: ch }, i, depth + 1);
  };
  sc.fields.forEach((f, i) => addRow(f, i, 0));
  box.append(table);
  if (sc.metadata) {
    box.append(el('h3', null, 'File metadata'));
    const md = el('dl', 'facts meta');
    for (const [k, v] of Object.entries(sc.metadata)) md.append(el('dt', null, k), el('dd', 'mono', String(v).length > 600 ? String(v).slice(0, 600) + '…' : v));
    box.append(md);
  }
  if (sc.schemaText) {
    const det = el('details', 'rawschema');
    det.append(el('summary', null, 'Avro schema (JSON)'), el('pre', 'value json', sc.schemaText));
    box.append(det);
  }
  schemaPane.append(box);
}

// ---------- search, pager, export ----------
function runSearch() {
  const text = search.value;
  if (!text) { post({ type: 'clearView' }); return; }
  post({ type: 'search', text, col: Number(colSel.value) });
  btnCancel.hidden = false;
  jobText.classList.remove('err');
  jobText.textContent = 'Searching…';
}
btnRun.addEventListener('click', runSearch);
search.addEventListener('keydown', e => { if (e.key === 'Enter') runSearch(); if (e.key === 'Escape' && !btnCancel.hidden) post({ type: 'cancel' }); });
btnCancel.addEventListener('click', () => post({ type: 'cancel' }));
bannerAct.addEventListener('click', () => { search.value = ''; post({ type: 'clearView' }); });

function topRow() { return S.count ? visibleRange().first : 0; }
function pageOf(pos) { return Math.floor(pos / S.pageRows); }
function pages() { return Math.max(1, Math.ceil(S.count / S.pageRows)); }
btnPrev.addEventListener('click', () => scrollToPos(Math.max(0, (pageOf(topRow()) - (topRow() % S.pageRows ? 0 : 1)) * S.pageRows)));
btnNext.addEventListener('click', () => scrollToPos(Math.min(S.count - 1, (pageOf(topRow()) + 1) * S.pageRows)));
rowInput.addEventListener('keydown', e => {
  if (e.key !== 'Enter') return;
  const n = parseInt(rowInput.value.replace(/[^\d]/g, ''), 10);
  if (!n) return;
  if (S.label) { flash('Row numbers jump within the search results. Clear the search to jump in the file.'); }
  const pos = Math.min(S.count - 1, n - 1);
  setFocus(pos, undefined, false);
  scrollToPos(pos);
});
exportSel.addEventListener('change', () => {
  const v = exportSel.value;
  exportSel.value = '';
  if (!v) return;
  const [scope, format] = v.split(':');
  post({ type: 'export', scope, format, start: pageOf(topRow()) * S.pageRows });
});

function updateStatus() {
  if (S.fatal) return;
  const { first, last } = S.count ? visibleRange() : { first: 0, last: -1 };
  statusLeft.textContent = S.count ? `Rows ${fmtN(first + 1)}–${fmtN(last + 1)} of ${fmtN(S.count)}${S.label ? ' matches' : ''}` : (S.label ? 'No matches' : 'No rows');
  pageText.textContent = `Page ${fmtN(pageOf(first) + 1)} of ${fmtN(pages())}`;
  btnPrev.disabled = first === 0;
  btnNext.disabled = pageOf(first) + 1 >= pages();
}

function updateStats() {
  const i = S.info;
  if (!i) return;
  stats.textContent = `${fmtN(S.total)}${S.done ? '' : '+'} rows · ${fmtN(S.columns.length)} columns · ${i.sizeText}`;
  statusMid.textContent = S.done ? '' : `Indexing… ${fmtN(S.total)} rows found`;
}

function resetCache() {
  S.cache.clear();
  S.pending.clear();
}

// ---------- messages ----------
window.addEventListener('message', ev => {
  const m = ev.data;
  if (!m || typeof m.type !== 'string') return;
  switch (m.type) {
    case 'init': {
      S.info = m; S.schema = m.schema; S.total = m.count; S.count = m.viewCount; S.done = m.done; S.version = m.viewVersion;
      S.chunk = m.limits.chunk; S.pageRows = m.limits.page; S.label = m.viewLabel || '';
      fmtBadge.textContent = m.kind === 'avro' ? 'AVRO' : /Feather/.test(m.format) ? 'FEATHER' : 'ARROW';
      fmtBadge.title = m.format;
      setColumns(m.columns);
      resetCache();
      updateStats();
      setMode(S.mode === 'schema' ? 'schema' : 'table');
      break;
    }
    case 'progress': {
      S.total = m.count; S.done = m.done; S.info.batches = m.batches;
      if (!S.label && m.viewCount !== S.count) { S.count = m.viewCount; layout(); }
      updateStats();
      if (S.mode === 'schema') renderSchema();
      break;
    }
    case 'rows': {
      S.pending.delete(m.version + ':' + Math.floor(m.start / S.chunk));
      if (m.version !== S.version) return;
      if (m.error) { flash(m.error); jobText.classList.add('err'); jobText.textContent = m.error; return; }
      S.cache.set(Math.floor(m.start / S.chunk), m.rows);
      if (S.cache.size > 60) { const k = S.cache.keys().next().value; S.cache.delete(k); }
      autoSize(m.rows);
      schedule();
      break;
    }
    case 'cell': onCell(m); break;
    case 'stats': onStats(m); break;
    case 'view': {
      S.version = m.version; S.count = m.count; S.label = m.label || '';
      resetCache();
      S.focus = -1;
      banner.hidden = !S.label;
      bannerText.textContent = S.label ? `${fmtN(m.count)} rows match ${m.label}` : '';
      grid.scrollTop = 0;
      layout();
      break;
    }
    case 'job': {
      const running = m.state === 'running';
      btnCancel.hidden = !running;
      jobText.classList.toggle('err', m.state === 'error');
      if (m.state === 'error') jobText.textContent = m.message;
      else if (m.kind === 'search') {
        jobText.textContent = running ? `Searching… ${fmtN(m.done)} of ${fmtN(m.total)} rows · ${fmtN(m.matches)} found`
          : m.state === 'cancelled' ? `Stopped · ${fmtN(m.matches)} found so far` : `${fmtN(m.matches)} found in ${fmtMs(m.ms || 0)}`;
      } else if (m.kind === 'export') {
        jobText.textContent = running ? `Exporting… ${fmtN(m.done)} of ${fmtN(m.total)}` : m.state === 'cancelled' ? 'Export stopped' : `Exported ${fmtN(m.written)} rows`;
      }
      break;
    }
    case 'error': {
      if (m.fatal) {
        S.fatal = m.message;
        fatalBox.hidden = false;
        fatalBox.textContent = '';
        fatalBox.append(el('div', 'ftitle', 'This file cannot be shown'), el('div', 'fmsg', m.message));
        tablePane.hidden = schemaPane.hidden = findbar.hidden = true;
        statusLeft.textContent = '';
        statusRight.textContent = '';
      } else flash(m.message);
      break;
    }
  }
});

setMode(S.mode);
post({ type: 'ready' });
