import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import vm from 'node:vm';
import {test} from 'node:test';
import {LookupDB} from '../web/lookup.mjs';
import {normalizeSession, sessionsFromMessage, formatReturnBps, renderAnnotations} from
  '../extension/quiz-core.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cases = JSON.parse(await readFile(path.join(root, 'tests/fixtures/quiz_har_cases.json'), 'utf8'));

function asSession(rows, id = 'session-1') {
  return {
    session_id: id,
    entry_price: String(rows.at(-1)[4]),
    chart_candles: rows.map(([date, open, high, low, close, volume]) =>
      ({date, open: String(open), high, low, close, volume})),
  };
}

test('normalizes the last three quiz candles and refuses mismatched entry price', () => {
  const rows = [
    ['2025-03-11', 1, 2, 1, 2, 10],
    ['2025-03-12', 2, 3, 2, 3, 20],
    ['2025-03-13', 3, 4, 3, 4, 30],
    ['2025-03-14', 4, 5, 4, 5, 40],
  ];
  assert.deepEqual(normalizeSession(asSession(rows)).bars, rows.slice(-3));
  const mismatch = asSession(rows);
  mismatch.entry_price = '6';
  assert.equal(normalizeSession(mismatch).reason, 'entry-mismatch');
  const fraction = asSession(rows);
  fraction.chart_candles[3].volume = 1.5;
  assert.equal(normalizeSession(fraction).reason, 'invalid');
  assert.equal(formatReturnBps(257), '+2.57%');
  assert.equal(formatReturnBps(-150), '-1.50%');
  assert.equal(formatReturnBps(0), '0.00%');
});

test('accepts only same-window, same-origin, minimal session messages', () => {
  const source = {};
  const session = asSession([
    ['2025-03-12', 2, 3, 2, 3, 20],
    ['2025-03-13', 3, 4, 3, 4, 30],
    ['2025-03-14', 4, 5, 4, 5, 40],
  ]);
  const event = {source, origin: 'https://scalping.kro.kr',
    data: {type: 'SCALP_QUIZ_SESSIONS', sessions: [session]}};
  assert.deepEqual(sessionsFromMessage(event, source, event.origin), [session]);
  assert.equal(sessionsFromMessage({...event, source: {}}, source, event.origin), null);
  assert.equal(sessionsFromMessage({...event, origin: 'https://elsewhere.example'}, source, event.origin), null);
  assert.equal(sessionsFromMessage({...event, data: {...event.data, type: 'OTHER'}}, source, event.origin), null);
  assert.equal(sessionsFromMessage({...event, data: {...event.data, sessions: [session, session]}}, source, event.origin), null);
  assert.equal(sessionsFromMessage({...event, data: {...event.data, sessions: [
    {...session, chart_candles: [...session.chart_candles, session.chart_candles[2]]},
  ]}}, source, event.origin), null);
});

test('MAIN-world hook captures fetch and XHR but forwards no auth or extra response fields', async () => {
  const messages = [];
  const candle = {date: '2025-03-14', open: 11950, high: 12260, low: 11950,
    close: 12220, volume: 226868, secret: 'omit'};
  const body = {sessions: [{session_id: 'abc', entry_price: 12220,
    chart_candles: [candle, candle, candle, candle], csrfToken: 'omit'}],
  request_id: 'omit', csrfToken: 'omit'};
  class FakeXHR {
    listeners = new Map();
    responseType = '';
    status = 200;
    responseText = JSON.stringify(body);
    addEventListener(name, handler) { this.listeners.set(name, handler); }
    open(method, url) { this.method = method; this.url = url; }
    send() { this.listeners.get('loadend')?.(); }
  }
  const location = {href: 'https://scalping.kro.kr/quiz', origin: 'https://scalping.kro.kr'};
  const window = {postMessage: (message, origin) => messages.push({message, origin}),
    fetch: async () => ({ok: true, clone: () => ({json: async () => body})})};
  const context = {window, location, URL, Request, XMLHttpRequest: FakeXHR,
    WeakMap, Reflect, JSON, String, Array};
  vm.runInNewContext(await readFile(path.join(root, 'extension/page-hook.js'), 'utf8'), context);
  await window.fetch('/api/quiz/state');
  await new Promise(resolve => setImmediate(resolve));
  const xhr = new FakeXHR();
  xhr.open('POST', '/api/quiz/round');
  xhr.send();
  assert.equal(messages.length, 2);
  for (const {message, origin} of messages) {
    assert.equal(origin, location.origin);
    assert.equal(message.type, 'SCALP_QUIZ_SESSIONS');
    assert.equal(message.sessions[0].chart_candles.length, 3);
    assert.deepEqual(Object.keys(message.sessions[0]).sort(), ['chart_candles', 'entry_price', 'session_id']);
    assert.deepEqual(Object.keys(message.sessions[0].chart_candles[0]).sort(),
      ['close', 'date', 'high', 'low', 'open', 'volume']);
    assert.ok(!JSON.stringify(message).includes('omit'));
  }
  await window.fetch('https://other.example/api/quiz/state');
  assert.equal(messages.length, 2);
});

test('DOM annotation reuses its badge after repeated rendering and updates', () => {
  class Element {
    constructor(classes = []) {
      this.classList = {contains: name => classes.includes(name)};
      this.children = [];
      this.attrs = new Map();
      this.textContent = '';
    }
    hasAttribute(name) { return this.attrs.has(name); }
    setAttribute(name, value) { this.attrs.set(name, value); }
    getAttribute(name) { return this.attrs.get(name) ?? null; }
    prepend(child) { this.children.unshift(child); }
    insertAdjacentElement(_position, child) { card.children.push(child); }
    remove() { card.children.splice(card.children.indexOf(this), 1); }
  }
  const card = new Element(['q-chart-card']);
  card.children.push(new Element(['q-card-n']));
  const grid = {children: [card]};
  const doc = {querySelector: selector => selector === '.q-cards-grid' ? grid : null,
    createElement: () => new Element()};
  const sessions = [{session_id: 'abc'}];
  const results = new Map([['abc', {text: '넥슨게임즈 | 0.00%', tone: 'zero'}]]);
  assert.equal(renderAnnotations(doc, sessions, results), 1);
  assert.equal(renderAnnotations(doc, sessions, results), 1);
  assert.equal(card.children.filter(child => child.hasAttribute('data-scalp-lookup')).length, 1);
  results.set('abc', {text: '지아이이노베이션 | +2.57%', tone: 'positive'});
  renderAnnotations(doc, sessions, results);
  assert.equal(card.children[1].textContent, '지아이이노베이션 | +2.57%');
});

test('packaged window=3 DB resolves all six HAR regression cases', async t => {
  const manifestPath = path.join(root, 'data/lookup/manifest.json');
  if (!existsSync(manifestPath)) return t.skip('local generated DB is unavailable');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const entry = manifest.files.find(file => file.window === 3);
  const [buffer, stocks] = await Promise.all([
    readFile(path.join(root, 'data/lookup', entry.file)),
    readFile(path.join(root, 'data/lookup', manifest.stocksFile), 'utf8'),
  ]);
  const db = new LookupDB(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength),
    JSON.parse(stocks), 3);
  for (const fixture of cases) {
    const cachePath = path.join(root, 'cache/bars', `${fixture.code}.json`);
    if (!existsSync(cachePath)) return t.skip('local collected cache is unavailable');
    const rows = JSON.parse(await readFile(cachePath, 'utf8')).rows;
    const index = rows.findIndex(row => row[0] === fixture.lastBar[0]);
    assert.ok(index >= 2, fixture.code);
    assert.deepEqual(rows[index], fixture.lastBar);
    const item = normalizeSession(asSession(rows.slice(index - 2, index + 1), fixture.code));
    assert.ok(item.bars, fixture.code);
    const matches = await db.lookup(item.bars);
    assert.equal(matches.length, 1, fixture.code);
    assert.equal(matches[0].code, fixture.code);
    assert.equal(matches[0].name, fixture.name);
    assert.equal(matches[0].lastDate, fixture.lastBar[0]);
    assert.equal(matches[0].nextDate, fixture.nextDate);
    assert.equal(matches[0].nextReturnBps, fixture.nextReturnBps);
  }
});
