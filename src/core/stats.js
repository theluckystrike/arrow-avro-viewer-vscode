'use strict';
// Streaming column statistics. Feed values with add(), read the result with result().

const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);
const fixBig = x => (typeof x !== 'bigint' ? x : x <= MAX_SAFE && x >= -MAX_SAFE ? Number(x) : x.toString());

class ColumnStats {
  constructor(maxDistinct = 100000) {
    this.maxDistinct = maxDistinct;
    this.count = 0;
    this.nulls = 0;
    this.distinct = new Map(); // key text -> count
    this.overflow = false;
    this.nums = 0; this.sum = 0; this.sumSq = 0; this.min = undefined; this.max = undefined;
    this.bigMin = undefined; this.bigMax = undefined;
    this.strMin = undefined; this.strMax = undefined;
    this.lenMin = Infinity; this.lenMax = 0;
    this.trues = 0; this.falses = 0;
  }

  add(v) {
    this.count++;
    if (v === null || v === undefined) { this.nulls++; return; }
    let key;
    if (typeof v === 'number') {
      if (Number.isFinite(v)) {
        this.nums++; this.sum += v; this.sumSq += v * v;
        if (this.min === undefined || v < this.min) this.min = v;
        if (this.max === undefined || v > this.max) this.max = v;
      }
      key = String(v);
    } else if (typeof v === 'bigint') {
      if (this.bigMin === undefined || v < this.bigMin) this.bigMin = v;
      if (this.bigMax === undefined || v > this.bigMax) this.bigMax = v;
      this.nums++; this.sum += Number(v); this.sumSq += Number(v) * Number(v);
      key = v.toString();
    } else if (typeof v === 'boolean') {
      if (v) this.trues++; else this.falses++;
      key = String(v);
    } else {
      key = typeof v === 'string' ? v : JSON.stringify(v);
      if (this.strMin === undefined || key < this.strMin) this.strMin = key;
      if (this.strMax === undefined || key > this.strMax) this.strMax = key;
      if (key.length < this.lenMin) this.lenMin = key.length;
      if (key.length > this.lenMax) this.lenMax = key.length;
    }
    if (!this.overflow) {
      if (key.length > 200) key = key.slice(0, 200) + '…';
      const c = this.distinct.get(key);
      if (c !== undefined) this.distinct.set(key, c + 1);
      else if (this.distinct.size >= this.maxDistinct) this.overflow = true;
      else this.distinct.set(key, 1);
    }
  }

  result() {
    const r = { count: this.count, nulls: this.nulls, nonNull: this.count - this.nulls };
    r.distinct = this.overflow ? null : this.distinct.size;
    r.distinctAtLeast = this.overflow ? this.maxDistinct : undefined;
    if (this.nums) {
      const mean = this.sum / this.nums;
      r.mean = mean;
      r.std = this.nums > 1 ? Math.sqrt(Math.max(0, (this.sumSq - this.nums * mean * mean) / (this.nums - 1))) : 0;
      const lo = [this.min, this.bigMin].filter(x => x !== undefined);
      const hi = [this.max, this.bigMax].filter(x => x !== undefined);
      r.min = lo.reduce((a, b) => (a === undefined || b < a ? b : a), undefined);
      r.max = hi.reduce((a, b) => (a === undefined || b > a ? b : a), undefined);
      r.min = fixBig(r.min);
      r.max = fixBig(r.max);
    } else if (this.strMin !== undefined) {
      r.min = this.strMin.slice(0, 200); r.max = this.strMax.slice(0, 200);
      r.lenMin = this.lenMin; r.lenMax = this.lenMax;
    }
    if (this.trues || this.falses) { r.trues = this.trues; r.falses = this.falses; }
    if (!this.overflow) {
      r.top = [...this.distinct.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, 10).map(([value, n]) => ({ value, n }));
    }
    return r;
  }
}

module.exports = { ColumnStats };
