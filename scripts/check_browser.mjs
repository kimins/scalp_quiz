// Cross-language check against ALL records from a chosen cached stock.
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import assert from 'node:assert/strict';
import {LookupDB} from '../web/lookup.mjs';

const [out = 'data/lookup', cache = 'cache', code = '005930'] = process.argv.slice(2);
const json = async p => JSON.parse(await readFile(p, 'utf8'));
const manifest = await json(join(out, 'manifest.json'));
const stocks = await json(join(out, manifest.stocksFile));
const stock = stocks.find(s => s.code === code);
assert.ok(stock, 'Stock not in built DB');
const {rows} = await json(join(cache, 'bars', `${code}.json`));
const valid = r => r.slice(1).every(n => n > 0) && r[3] <= Math.min(r[1], r[4]) && Math.max(r[1], r[4]) <= r[2];
let checked = 0;
for (const file of manifest.files) {
  const bytes = await readFile(join(out, file.file));
  const db = new LookupDB(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), stocks, file.window);
  for (let i = file.window - 1; i < rows.length - 1; i++) {
    if (rows[i][0] < manifest.requestedStart || rows[i][0] > manifest.effectiveEnd) continue;
    const tail = rows.slice(i - file.window + 1, i + 1);
    if (![...tail, rows[i + 1]].every(valid)) continue;
    const result = (await db.lookup(tail)).find(r => r.stockId === stock.stockId && r.lastDate === rows[i][0]);
    assert.ok(result, `Missing ${code} ${rows[i][0]}`);
    assert.equal(result.nextDate, rows[i + 1][0]);
    // Exact integer rounding, including negative half ties.
    const numerator = BigInt(rows[i + 1][4] - rows[i][4]) * 10000n;
    const denominator = BigInt(rows[i][4]);
    const absolute = numerator < 0n ? -numerator : numerator;
    const rounded = (absolute * 2n + denominator) / (2n * denominator);
    assert.equal(result.nextReturnBps, Number(numerator < 0n ? -rounded : rounded));
    checked++;
  }
  const nonexistent = rows.filter(valid).slice(0, file.window).map(r => [r[0], ...r.slice(1, 5).map(v => v + 1234567), r[5]]);
  assert.deepEqual(await db.lookup(nonexistent), []);
}
assert.ok(checked > 0);
console.log(JSON.stringify({code, browserRecordsVerified: checked}));
