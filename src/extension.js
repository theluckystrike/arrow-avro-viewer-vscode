'use strict';
const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const { createSession } = require('./core/protocol');
const { makeDoc } = require('./core/dataset');
const { FileSource, BufferSource } = require('./core/source');
const { ReadError, fmtGB } = require('./core/arrowdoc');
const L = require('./core/limits');
const { buildHtml } = require('./html');
const { createRatingPrompt } = require('./rate');
const { registerSupport, commandUris, showLinks } = require('./support');

let rating = { success() {} };

const VIEW_TYPE = 'arrowAvroViewer.viewer';
const TABLE_VIEWER = 'zovo.table-viewer-vscode';

class ViewerProvider {
  constructor(context) { this.context = context; }

  openCustomDocument(uri) { return { uri, dispose() {} }; }

  async resolveCustomEditor(document, panel) {
    const uri = document.uri;
    const ctx = this.context;
    const dist = vscode.Uri.joinPath(ctx.extensionUri, 'dist');
    const media = vscode.Uri.joinPath(ctx.extensionUri, 'media');
    // Command links are limited to the two support commands and the settings page (footer "Hide" link).
    panel.webview.options = { enableScripts: true, localResourceRoots: [dist, media], enableCommandUris: commandUris('arrowAvroViewer') };
    panel.webview.html = buildHtml({
      cspSource: panel.webview.cspSource,
      scriptUri: panel.webview.asWebviewUri(vscode.Uri.joinPath(dist, 'webview.js')).toString(),
      styleUri: panel.webview.asWebviewUri(vscode.Uri.joinPath(media, 'webview.css')).toString(),
      title: path.posix.basename(uri.path),
      showSupportLinks: showLinks(vscode, 'arrowAvroViewer'),
    });

    const name = path.posix.basename(uri.path);
    let counted = false; // one success per opened tab, for the rating prompt
    const post = m => {
      panel.webview.postMessage(m).then(undefined, () => {});
      if (!counted && m && m.type === 'init') { counted = true; rating.success(); }
    };
    let doc;
    try {
      doc = await makeDoc(uri.scheme === 'file' ? new FileSource(uri.fsPath) : await remoteSource(uri), name);
    } catch (e) {
      const message = e instanceof ReadError ? e.message : 'Could not open the file: ' + e.message;
      panel.webview.onDidReceiveMessage(m => { if (m && m.type === 'ready') post({ type: 'error', fatal: true, message }); });
      post({ type: 'error', fatal: true, message });
      return;
    }
    const session = createSession({
      doc,
      post,
      host: {
        copy: text => vscode.env.clipboard.writeText(text),
        openWriter: (format, defaultName) => openWriter(uri, format, defaultName),
        exported: info => exported(info),
        hint: () => tableViewerHint(),
      },
    });
    panel.webview.onDidReceiveMessage(m => session.handle(m));
    panel.onDidDispose(() => { session.dispose(); });
    session.start();
  }
}

async function remoteSource(uri) {
  const st = await vscode.workspace.fs.stat(uri);
  if (st.size > L.MAX_REMOTE_BYTES) throw new ReadError(`This remote file is ${fmtGB(st.size)}. Files outside the local disk are read whole, so the limit is 256 MB.`, 'TOO_BIG');
  return new BufferSource(Buffer.from(await vscode.workspace.fs.readFile(uri)));
}

async function openWriter(uri, format, defaultName) {
  const filters = { csv: { CSV: ['csv'] }, json: { JSON: ['json'] } }[format];
  const dir = vscode.Uri.joinPath(uri, '..');
  const target = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.joinPath(dir, defaultName), filters, saveLabel: 'Export' });
  if (!target) return null;
  if (target.toString() === uri.toString()) {
    vscode.window.showErrorMessage('Pick a new file name. The export never writes over the file you are viewing.');
    return null;
  }
  if (target.scheme === 'file') {
    const ws = fs.createWriteStream(target.fsPath);
    const failed = new Promise((_, rej) => ws.on('error', rej));
    failed.catch(() => {});
    return {
      label: path.basename(target.fsPath),
      uri: target,
      write: s => Promise.race([failed, new Promise(res => { if (ws.write(s)) res(); else ws.once('drain', res); })]),
      close: () => Promise.race([failed, new Promise(res => ws.end(res))]),
    };
  }
  const parts = [];
  return {
    label: path.posix.basename(target.path),
    uri: target,
    write: async s => { parts.push(Buffer.from(s, 'utf8')); },
    close: () => vscode.workspace.fs.writeFile(target, Buffer.concat(parts)),
  };
}

async function exported({ format, label, uri, written }) {
  const text = `Saved ${written.toLocaleString('en-US')} rows to ${label}.`;
  const hasTable = !!vscode.extensions.getExtension(TABLE_VIEWER);
  const actions = format === 'csv' ? [hasTable ? 'Open in Table Viewer' : 'Open'] : ['Open'];
  const pick = await vscode.window.showInformationMessage(text, ...actions);
  if (!pick || !uri) return;
  if (pick === 'Open in Table Viewer') await vscode.commands.executeCommand('vscode.openWith', uri, 'tableViewer.tableText');
  else await vscode.commands.executeCommand('vscode.open', uri);
}

async function tableViewerHint() {
  if (vscode.extensions.getExtension(TABLE_VIEWER)) {
    vscode.window.showInformationMessage('Table Viewer by Zovo is installed. Open any .parquet, .csv or .xlsx file to use it.');
    return;
  }
  await vscode.commands.executeCommand('workbench.extensions.search', `@id:${TABLE_VIEWER}`);
}

function activate(context) {
  rating = createRatingPrompt({ vscode, context, extensionId: 'zovo.arrow-avro-viewer', section: 'arrowAvroViewer', message: (n) => `Avro and Arrow Viewer has opened ${n} files for you. A rating helps other people find it.` });
  registerSupport({ vscode, context, prefix: 'arrowAvroViewer', selfId: 'zovo.arrow-avro-viewer' });
  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(VIEW_TYPE, new ViewerProvider(context), {
      supportsMultipleEditorsPerDocument: true,
      webviewOptions: { retainContextWhenHidden: false },
    }),
    vscode.commands.registerCommand('arrowAvroViewer.open', async (uri) => {
      const target = uri instanceof vscode.Uri ? uri : vscode.window.activeTextEditor && vscode.window.activeTextEditor.document.uri;
      if (!target) return vscode.window.showInformationMessage('Select an .arrow, .feather, .ipc or .avro file first.');
      await vscode.commands.executeCommand('vscode.openWith', target, VIEW_TYPE);
    }),
    vscode.commands.registerCommand('arrowAvroViewer.getStarted', () =>
      vscode.commands.executeCommand('workbench.action.openWalkthrough', 'zovo.arrow-avro-viewer#arrowAvroViewer.start', false)),
  );
}

function deactivate() {}

module.exports = { activate, deactivate, VIEW_TYPE };
