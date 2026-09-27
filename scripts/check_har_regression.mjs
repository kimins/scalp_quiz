// Check the six observed quiz HAR bars against the cached source and the browser lookup.
// Local fetch emulates chrome.runtime.getURL() file responses in Node.js.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {resolve, sep} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {performance} from 'node:perf_hooks';
import {LookupDB, fingerprint} from '../web/lookup.mjs';

const [out = 'data/lookup', cache = 'cache'] = process.argv.slice(2);
const cases = JSON.parse(await readFile(new URL('../tests/fixtures/quiz_har_cases.json', import.meta.url), 'utf8'));
const baseURL = pathToFileURL(resolve(out) + sep).href;
const nativeFetch = globalThis.fetch;
globalThis.fetch = async url => {
  try {
    return new Response(await readFile(fileURLToPath(url)));
  } catch (error) {
    if (error.code === 'ENOENT') return new Response(null, {status: 404});
    throw error;
  }
};

const loadStart = performance.now();
let db;
try {
  db = await LookupDB.load(baseURL, 3);
} finally {
  globalThis.fetch = nativeFetch;
}
const loadMs = performance.now() - loadStart;

const returnBps = (close, nextClose) => {
  const numerator = BigInt(nextClose - close) * 10000n;
  const denominator = BigInt(close);
  const magnitude = numerator < 0n ? -numerator : numerator;
  const rounded = (magnitude * 2n + denominator) / (2n * denominator);
  return Number(numerator < 0n ? -rounded : rounded);
};

const inputs = [];
const harCases = [];
for (const item of cases) {
  const {rows} = JSON.parse(await readFile(resolve(cache, 'bars', `${item.code}.json`), 'utf8'));
  const index = rows.findIndex(row => row[0] === item.lastBar[0]);
  assert.ok(index >= 2 && index + 1 < rows.length, `${item.code}: three source bars and a following bar are required`);
  assert.deepEqual(rows[index], item.lastBar, `${item.code}: HAR last bar differs from Naver cache`);
  assert.equal(rows[index + 1][0], item.nextDate, `${item.code}: next trading date differs`);
  assert.equal(rows[index + 1][4], item.nextClose, `${item.code}: next close differs`);
  assert.equal(returnBps(item.lastBar[4], item.nextClose), item.nextReturnBps, `${item.code}: HAR return differs`);

  const bars = rows.slice(index - 2, index + 1);
  const matches = await db.lookup(bars);
  const result = matches.find(match => match.code === item.code);
  assert.ok(result, `${item.code}: no matching DB lookup candidate`);
  assert.equal(result.code, item.code);
  assert.equal(result.name, item.name);
  assert.equal(result.lastDate, item.lastBar[0]);
  assert.equal(result.nextDate, rows[index + 1][0]);
  assert.equal(result.nextReturnBps, item.nextReturnBps);
  inputs.push(bars);
  harCases.push({code: item.code, lastDate: result.lastDate, nextDate: result.nextDate,
    nextReturnBps: result.nextReturnBps, candidates: matches.length});
}

// The real DB has no duplicate keys; also exercise the browser's candidate scan.
const collisionKey = await fingerprint(inputs[0]);
const collisionBuffer = new ArrayBuffer(16 + 2 * 18);
const collisionBytes = new Uint8Array(collisionBuffer);
const collisionView = new DataView(collisionBuffer);
collisionBytes.set(new TextEncoder().encode('SCALPDB1'));
collisionView.setUint8(8, 1);
collisionView.setUint8(9, 3);
collisionView.setUint16(10, 18, true);
collisionView.setUint32(12, 2, true);
const collisionStocks = [...db.stocks.values()].slice(0, 2);
for (let i = 0; i < 2; i++) {
  const offset = 16 + i * 18;
  collisionBytes.set(collisionKey, offset);
  collisionView.setUint16(offset + 8, collisionStocks[i].stockId, true);
  collisionView.setUint16(offset + 10, 2000, true);
  collisionView.setUint16(offset + 12, 2001, true);
  collisionView.setInt32(offset + 14, i, true);
}
const collisionMatches = await new LookupDB(collisionBuffer, collisionStocks, 3).lookup(inputs[0]);
assert.deepEqual(collisionMatches.map(match => match.code), collisionStocks.map(stock => stock.code));

// Warm up Web Crypto and the lookup path before measuring fingerprint lookup time.
for (const bars of inputs) await db.lookup(bars);
const samples = [];
for (let repeat = 0; repeat < 100; repeat++) {
  for (const bars of inputs) {
    const start = performance.now();
    await db.lookup(bars);
    samples.push(performance.now() - start);
  }
}
samples.sort((a, b) => a - b);
const averageMs = samples.reduce((sum, ms) => sum + ms, 0) / samples.length;
console.log(JSON.stringify({harCases, nodeBenchmark: {loadMs, lookups: samples.length,
  averageMs, p95Ms: samples[Math.ceil(samples.length * 0.95) - 1], worstMs: samples.at(-1)},
  syntheticCollisionCandidates: collisionMatches.length}));
