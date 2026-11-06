'use strict';
// CSV and JSON text for exported rows. Values are plain (from values.js).

function csvField(v) {
  if (v === null || v === undefined) return '';
  const s = typeof v === 'string' ? v : typeof v === 'object' ? JSON.stringify(v) : String(v);
  return /[",\r\n]/.test(s) || /^\s|\s$/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function csvHeader(columns) { return columns.map(c => csvField(c.name)).join(',') + '\r\n'; }
function csvRow(values) { return values.map(csvField).join(',') + '\r\n'; }
function jsonRow(columns, values) {
  const o = {};
  columns.forEach((c, i) => { o[c.name] = values[i] === undefined ? null : values[i]; });
  return JSON.stringify(o);
}

module.exports = { csvField, csvHeader, csvRow, jsonRow };
