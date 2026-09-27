// Browser/Chrome MV3 compatible. Requires Web Crypto (extension/HTTPS/localhost).
const HEADER = 16;
const RECORD = 18;
const encoder = new TextEncoder();
const hex = bytes => Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
const dateFromDay = n => new Date(Date.UTC(2020, 0, 1) + n * 86400000).toISOString().slice(0, 10);

export function canonical(rows) {
  if (![3, 4, 5].includes(rows.length)) throw new Error('Expected 3, 4 or 5 bars');
  let previous = '';
  for (const row of rows) {
    const [day, o, h, l, c, v] = row;
    if (row.length !== 6 || typeof day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(day) ||
        !Number.isFinite(Date.parse(day)) || new Date(day).toISOString().slice(0, 10) !== day ||
        day <= previous || ![o, h, l, c, v].every(x => Number.isSafeInteger(x) && x > 0) ||
        !(l <= Math.min(o, c) && Math.max(o, c) <= h)) throw new Error('Invalid OHLCV bar');
    previous = day;
  }
  return `scalp-v1|${rows.length}\n${rows.map(r => r.join('|')).join('\n')}\n`;
}

export async function fingerprint(rows) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(canonical(rows)))).slice(0, 8);
}

export class LookupDB {
  constructor(buffer, stocks, window) {
    this.bytes = new Uint8Array(buffer);
    this.view = new DataView(buffer);
    this.stocks = new Map(stocks.map(s => [s.stockId, s]));
    if (buffer.byteLength < HEADER || new TextDecoder().decode(this.bytes.slice(0, 8)) !== 'SCALPDB1' ||
        this.view.getUint8(8) !== 1 || this.view.getUint8(9) !== window ||
        this.view.getUint16(10, true) !== RECORD) throw new Error('Invalid database header');
    this.count = this.view.getUint32(12, true);
    this.window = window;
    if (buffer.byteLength !== HEADER + this.count * RECORD) throw new Error('Invalid database length');
  }

  static async load(baseURL, window = 3) {
    const base = baseURL.endsWith('/') ? baseURL : `${baseURL}/`;
    const get = async file => {
      const r = await fetch(base + file);
      if (!r.ok) throw new Error(`DB fetch failed: ${r.status}`);
      return r;
    };
    const manifest = await (await get('manifest.json')).json();
    if (manifest.version !== 1) throw new Error('Unsupported manifest');
    const entry = manifest.files.find(f => f.window === window);
    if (!entry) throw new Error(`Window ${window} was not built`);
    const [buffer, stockBuffer] = await Promise.all([
      get(entry.file).then(r => r.arrayBuffer()),
      get(manifest.stocksFile).then(r => r.arrayBuffer()),
    ]);
    for (const [data, expected] of [[buffer, entry.sha256], [stockBuffer, manifest.stocksSha256]]) {
      if (hex(new Uint8Array(await crypto.subtle.digest('SHA-256', data))) !== expected)
        throw new Error('Database checksum mismatch');
    }
    return new LookupDB(buffer, JSON.parse(new TextDecoder().decode(stockBuffer)), window);
  }

  async lookup(rows) {
    if (rows.length !== this.window) throw new Error('Window mismatch');
    const key = await fingerprint(rows);
    const compare = i => {
      const offset = HEADER + i * RECORD;
      for (let j = 0; j < 8; j++) {
        const diff = this.bytes[offset + j] - key[j];
        if (diff) return diff;
      }
      return 0;
    };
    let lo = 0, hi = this.count;
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      if (compare(mid) < 0) lo = mid + 1;
      else hi = mid;
    }
    const matches = [];
    while (lo < this.count && compare(lo) === 0) {
      const pos = HEADER + lo * RECORD;
      const stockId = this.view.getUint16(pos + 8, true);
      const stock = this.stocks.get(stockId);
      if (!stock) throw new Error('Unknown stockId');
      const bps = this.view.getInt32(pos + 14, true);
      matches.push({...stock, lastDate: dateFromDay(this.view.getUint16(pos + 10, true)),
        nextDate: dateFromDay(this.view.getUint16(pos + 12, true)), nextReturnBps: bps, nextReturnPercent: bps / 100});
      lo++;
    }
    return matches; // []: unavailable; >1: ambiguous, never pick arbitrarily.
  }
}
