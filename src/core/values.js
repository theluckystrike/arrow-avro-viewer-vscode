'use strict';
// Turns decoded Arrow / Avro values into JSON-safe plain values and short cell text.

const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);
const MIN_SAFE = -MAX_SAFE;

function bigToPlain(v) { return v <= MAX_SAFE && v >= MIN_SAFE ? Number(v) : v.toString(); }

function hex(bytes, max = 48) {
  const n = Math.min(bytes.length, max);
  let s = '';
  for (let i = 0; i < n; i++) s += bytes[i].toString(16).padStart(2, '0');
  return `0x${s}${bytes.length > max ? '…' : ''} (${bytes.length} B)`;
}

function isoMs(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return String(ms);
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return String(ms);
  return d.toISOString().replace('.000Z', 'Z');
}

/** Two's-complement big-endian bytes to a decimal string with scale. */
function decimalFromBytes(bytes, scale) {
  if (!bytes.length) return '0';
  let v = 0n;
  for (const b of bytes) v = (v << 8n) | BigInt(b);
  if (bytes[0] & 0x80) v -= 1n << BigInt(bytes.length * 8);
  return scaleBig(v, scale);
}

function scaleBig(v, scale) {
  scale = scale || 0;
  const neg = v < 0n;
  let s = (neg ? -v : v).toString();
  if (scale > 0) {
    s = s.padStart(scale + 1, '0');
    s = s.slice(0, s.length - scale) + '.' + s.slice(s.length - scale);
  }
  return (neg ? '-' : '') + s;
}

/** Generic deep conversion for values without type info. */
function plain(v, depth = 0) {
  if (v === null || v === undefined) return null;
  const t = typeof v;
  if (t === 'string' || t === 'boolean') return v;
  if (t === 'number') return Number.isFinite(v) ? v : String(v);
  if (t === 'bigint') return bigToPlain(v);
  if (depth > 32) return '…';
  if (v instanceof Uint8Array) return hex(v);
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString();
  if (ArrayBuffer.isView(v)) return Array.from(v, x => plain(x, depth + 1));
  if (Array.isArray(v)) return v.map(x => plain(x, depth + 1));
  if (v instanceof Map) { const o = {}; for (const [k, x] of v) o[String(k)] = plain(x, depth + 1); return o; }
  if (typeof v.toJSON === 'function' && !(v.constructor === Object)) return plain(v.toJSON(), depth + 1);
  if (typeof v[Symbol.iterator] === 'function' && !(v.constructor === Object)) return Array.from(v, x => plain(x, depth + 1));
  const o = {};
  for (const k of Object.keys(v)) o[k] = plain(v[k], depth + 1);
  return o;
}

function cellText(v, max = 2000) {
  if (v === null || v === undefined) return null;
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s.length > max ? s.slice(0, max) + '…' : s;
}

/** JSON.stringify that writes big ints (already strings) as they are. */
function jsonText(v, indent) { return JSON.stringify(v, (k, x) => (typeof x === 'bigint' ? x.toString() : x), indent); }

/** One of: num, bool, str, time, nested, bin, null. Used for cell alignment and colors. */
function kindOf(v) {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'number') return 'num';
  if (typeof v === 'boolean') return 'bool';
  if (typeof v === 'string') return 'str';
  return 'nested';
}

module.exports = { plain, cellText, jsonText, kindOf, hex, isoMs, decimalFromBytes, scaleBig, bigToPlain };
