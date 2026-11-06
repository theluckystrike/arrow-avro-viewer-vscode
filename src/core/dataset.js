'use strict';
// Picks the reader for a file: Avro container ("Obj\x01" header) or Arrow IPC / Feather V2.
const { ArrowDoc } = require('./arrowdoc');
const { AvroDoc } = require('./avrodoc');

const EXT = /\.(arrow|arrows|feather|ipc|avro)$/i;

/** Sniff from the first bytes; fall back to the file extension. */
function pickReader(name, head) {
  if (head && head.length >= 4 && head[0] === 0x4f && head[1] === 0x62 && head[2] === 0x6a && head[3] === 0x01) return 'avro';
  if (head && head.length >= 6 && head.subarray(0, 6).toString('latin1') === 'ARROW1') return 'arrow';
  if (head && head.length >= 4 && head.readUInt32LE(0) === 0xffffffff) return 'arrow';
  return /\.avro$/i.test(name) ? 'avro' : 'arrow';
}

async function makeDoc(source, name) {
  await source.open();
  let head;
  try { head = await source.read(0, 8); } catch (e) { await source.close(); throw e; }
  const kind = pickReader(name, head);
  return kind === 'avro' ? new AvroDoc({ source, name }) : new ArrowDoc({ source, name });
}

module.exports = { pickReader, makeDoc, EXT };
