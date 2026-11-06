'use strict';
// Random-access byte sources: a file on disk (read by position) or a buffer.
const fs = require('fs');

class FileSource {
  constructor(path) { this.path = path; this.fh = null; this.size = 0; }
  async open() {
    if (this.fh) return this;
    this.fh = await fs.promises.open(this.path, 'r');
    this.size = (await this.fh.stat()).size;
    return this;
  }
  async read(pos, len) {
    len = Math.max(0, Math.min(len, this.size - pos));
    const buf = Buffer.allocUnsafe(len);
    let got = 0;
    while (got < len) {
      const { bytesRead } = await this.fh.read(buf, got, len - got, pos + got);
      if (!bytesRead) break;
      got += bytesRead;
    }
    return got === len ? buf : buf.subarray(0, got);
  }
  async close() { const fh = this.fh; this.fh = null; if (fh) await fh.close().catch(() => {}); }
}

class BufferSource {
  constructor(bytes) { this.buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength); this.size = this.buf.length; }
  async open() { return this; }
  async read(pos, len) { return this.buf.subarray(pos, Math.min(this.size, pos + len)); }
  async close() {}
}

module.exports = { FileSource, BufferSource };
