'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { buildHtml } = require('../src/html');

test('webview HTML has a strict CSP and escapes the title', () => {
  const html = buildHtml({ cspSource: 'vscode-resource:', scriptUri: 'vscode-resource:/dist/webview.js', styleUri: 'vscode-resource:/media/webview.css', title: '"><script>x</script>.avro', nonce: 'abc' });
  const csp = html.match(/Content-Security-Policy" content="([^"]+)"/)[1];
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /script-src 'nonce-abc'/);
  assert.doesNotMatch(csp, /https?:|unsafe-eval|unsafe-inline/);
  assert.doesNotMatch(html, /<script>x<\/script>/);
  assert.equal((html.match(/<script /g) || []).length, 1);
});

test('webview code puts file content in the DOM as text only', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'webview', 'main.js'), 'utf8');
  assert.doesNotMatch(src, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function/);
});

test('no network or telemetry code in the extension sources', () => {
  const dir = path.join(__dirname, '..', 'src');
  const files = [];
  const walk = d => { for (const f of fs.readdirSync(d, { withFileTypes: true })) f.isDirectory() ? walk(path.join(d, f.name)) : files.push(path.join(d, f.name)); };
  walk(dir);
  for (const f of files) {
    const s = fs.readFileSync(f, 'utf8');
    assert.doesNotMatch(s, /require\(['"](https?|net|http2|dgram)['"]\)|fetch\(|XMLHttpRequest|WebSocket/, f);
  }
});
