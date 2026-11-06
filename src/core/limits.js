'use strict';
// Size limits. Plain numbers so tests and the README can use them.
module.exports = {
  MAX_FILE_BYTES: 4 * 1024 * 1024 * 1024, // 4 GB: larger files show a message
  MAX_REMOTE_BYTES: 256 * 1024 * 1024, // non-file schemes are read whole
  MAX_BATCH_BYTES: 1024 * 1024 * 1024, // one record batch or Avro block is read whole
  CHUNK: 200, // rows per webview request
  PAGE_ROWS: 1000, // rows per page (pager and "export this page")
  MAX_VIEW: 5000000, // search matches kept
  CELL_CHARS: 2000, // text sent per grid cell
  VALUE_CHARS: 200000, // text sent for one cell in the detail drawer
  STATS_DISTINCT: 100000, // exact distinct count up to this many values
  BATCH_CACHE: 4,
};
