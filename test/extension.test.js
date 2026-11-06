'use strict';
// Loads the bundled extension with a stub vscode module: registration and one real file through the editor.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const Module = require('module');
const { tempDir, makeSamples } = require('./helpers');

const T = tempDir('ext');
test.before(() => makeSamples(T.dir));
test.after(() => T.cleanup());

function load(vscode) {
  const dist = path.join(__dirname, '..', 'dist', 'extension.js');
  if (!fs.existsSync(dist)) require('child_process').execFileSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'build.js')]);
  const orig = Module._load;
  Module._load = function (req, ...rest) { return req === 'vscode' ? vscode : orig.call(this, req, ...rest); };
  try { delete require.cache[dist]; return require(dist); } finally { Module._load = orig; }
}

function fakeVscode(reg) {
  class Uri {
    constructor(fsPath) { this.fsPath = fsPath; this.path = fsPath; this.scheme = 'file'; }
    static file(p) { return new Uri(p); }
    static joinPath(u, ...p) { return new Uri(path.join(u.fsPath, ...p)); }
    toString() { return 'file://' + this.fsPath; }
  }
  return {
    Uri,
    window: {
      registerCustomEditorProvider: (id, p, o) => { reg.editors.push([id, p, o]); return { dispose() {} }; },
      showInformationMessage: async () => undefined,
      state: { focused: true },
    },
    commands: { registerCommand: id => { reg.commands.push(id); return { dispose() {} }; }, executeCommand: async () => {} },
    workspace: { getConfiguration: () => ({ get: (k, d) => d }), isTrusted: true },
    env: { clipboard: { writeText: async () => {} }, sessionId: 's1', remoteName: undefined },
    extensions: { getExtension: () => undefined },
  };
}

function fakePanel() {
  const posted = [];
  let onMsg = () => {};
  const panel = {
    posted,
    webview: {
      options: {}, html: '', cspSource: 'vscode-resource:',
      asWebviewUri: u => u,
      postMessage: async m => { posted.push(m); return true; },
      onDidReceiveMessage: fn => { onMsg = fn; return { dispose() {} }; },
    },
    onDidDispose: fn => { panel.dispose = fn; return { dispose() {} }; },
    send: m => onMsg(m),
  };
  return panel;
}

const waitFor = async (pred, ms = 10000) => { const t = Date.now(); while (!pred()) { if (Date.now() - t > ms) throw new Error('timeout'); await new Promise(r => setTimeout(r, 10)); } };

test('activate registers the custom editor and the commands from package.json', () => {
  const reg = { editors: [], commands: [] };
  const ext = load(fakeVscode(reg));
  const ctx = { subscriptions: [], globalState: { get: () => undefined, update: async () => {} }, extensionUri: { fsPath: '/x' } };
  ext.activate(ctx);
  assert.deepEqual(reg.editors.map(e => e[0]), ['arrowAvroViewer.viewer']);
  assert.equal(reg.editors[0][2].webviewOptions.retainContextWhenHidden, false);
  const pkg = require('../package.json');
  assert.equal(pkg.contributes.customEditors[0].viewType, 'arrowAvroViewer.viewer');
  for (const c of pkg.contributes.commands) assert.ok(reg.commands.includes(c.command), c.command);
  const pats = pkg.contributes.customEditors[0].selector.map(s => s.filenamePattern).sort();
  assert.deepEqual(pats, ['*.arrow', '*.arrows', '*.avro', '*.feather', '*.ipc']);
});

test('the editor opens a real file, answers ready and serves rows; a bad file shows a fatal message', async () => {
  const reg = { editors: [], commands: [] };
  const vscode = fakeVscode(reg);
  const ext = load(vscode);
  ext.activate({ subscriptions: [], globalState: { get: () => undefined, update: async () => {} }, extensionUri: vscode.Uri.file('/ext') });
  const provider = reg.editors[0][1];
  const panel = fakePanel();
  await provider.resolveCustomEditor({ uri: vscode.Uri.file(T.file('sensor-readings.feather')) }, panel);
  assert.match(panel.webview.html, /Content-Security-Policy/);
  await waitFor(() => panel.posted.some(m => m.type === 'init'));
  panel.send({ type: 'getRows', reqId: 1, start: 0, count: 5 });
  await waitFor(() => panel.posted.some(m => m.type === 'rows'));
  assert.equal(panel.posted.find(m => m.type === 'rows').rows.length, 5);
  panel.dispose();

  fs.writeFileSync(T.file('bad.arrow'), 'not an arrow file at all');
  const p2 = fakePanel();
  await provider.resolveCustomEditor({ uri: vscode.Uri.file(T.file('bad.arrow')) }, p2);
  await waitFor(() => p2.posted.some(m => m.type === 'error'));
  assert.equal(p2.posted.find(m => m.type === 'error').fatal, true);
  p2.dispose && p2.dispose();
});
