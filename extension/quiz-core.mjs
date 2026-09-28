export const MESSAGE_TYPE = 'SCALP_QUIZ_SESSIONS';
export const LOOKUP_MESSAGE_TYPE = 'SCALP_QUIZ_LOOKUP_BATCH';
export const LOOKUP_RESPONSE_TYPE = 'SCALP_QUIZ_LOOKUP_RESULT';
export const LOOKUP_ERROR_TYPE = 'SCALP_QUIZ_LOOKUP_ERROR';

export function encodeLookupRequest(items) {
  if (!Array.isArray(items) || items.length > 24) throw new Error('Invalid lookup batch');
  return {type: LOOKUP_MESSAGE_TYPE, payload: JSON.stringify({lookups:
    items.map(({id, bars}) => ({id: String(id), bars}))})};
}

export function decodeLookupRequest(message) {
  if (message?.type !== LOOKUP_MESSAGE_TYPE || typeof message.payload !== 'string' ||
      message.payload.length > 262144) throw new Error('Invalid lookup message envelope');
  let body;
  try {
    body = JSON.parse(message.payload);
  } catch {
    throw new Error('Invalid lookup JSON payload');
  }
  return {type: LOOKUP_MESSAGE_TYPE, lookups: body?.lookups};
}

export function encodeLookupResponse(results) {
  return {type: LOOKUP_RESPONSE_TYPE, payload: JSON.stringify(results)};
}

export function decodeLookupResponse(response, expectedCount) {
  if (response?.type === LOOKUP_ERROR_TYPE) {
    const error = new Error(String(response.message || 'Background lookup failed'));
    error.stage = typeof response.stage === 'string' ? response.stage : 'background';
    throw error;
  }
  if (response?.type !== LOOKUP_RESPONSE_TYPE || typeof response.payload !== 'string' ||
      response.payload.length > 262144) {
    const error = new Error('Invalid Firefox response envelope');
    error.stage = 'runtime-response';
    throw error;
  }
  let results;
  try {
    results = JSON.parse(response.payload);
  } catch {
    const error = new Error('Invalid Firefox response JSON');
    error.stage = 'response-decode';
    throw error;
  }
  if (!Array.isArray(results) || results.length !== expectedCount || results.some(item =>
      !item || typeof item.id !== 'string' ||
      !['match', 'unknown', 'ambiguous'].includes(item.status))) {
    const error = new Error('Invalid Firefox lookup result list');
    error.stage = 'response-decode';
    throw error;
  }
  return results;
}

function integer(value) {
  if (Number.isSafeInteger(value)) return value;
  if (typeof value !== 'string' || !/^\d+$/.test(value.trim())) return null;
  const parsed = Number(value.trim());
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function validDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
}

export function normalizeSession(session) {
  const id = session?.session_id;
  if ((typeof id !== 'string' && typeof id !== 'number') || !String(id).trim()) return null;
  const key = String(id);
  const candles = session.chart_candles;
  if (!Array.isArray(candles) || candles.length < 3) return {id: key, bars: null, reason: 'missing'};
  const bars = [];
  let previous = '';
  for (const candle of candles.slice(-3)) {
    const date = candle?.date;
    const values = ['open', 'high', 'low', 'close', 'volume'].map(field => integer(candle?.[field]));
    if (!validDate(date) || date <= previous || values.some(value => value === null || value <= 0))
      return {id: key, bars: null, reason: 'invalid'};
    const [open, high, low, close] = values;
    if (low > Math.min(open, close) || high < Math.max(open, close))
      return {id: key, bars: null, reason: 'invalid'};
    bars.push([date, ...values]);
    previous = date;
  }
  const entry = integer(session.entry_price);
  if (entry === null || entry !== bars[2][4]) return {id: key, bars: null, reason: 'entry-mismatch'};
  return {id: key, bars, reason: null};
}

export function sessionsFromMessage(event, expectedWindow, expectedOrigin) {
  if (event.source !== expectedWindow || event.origin !== expectedOrigin) return null;
  const data = event.data;
  if (!data || data.type !== MESSAGE_TYPE || !Array.isArray(data.sessions) ||
      !Number.isSafeInteger(data.sessions.length) || data.sessions.length > 24)
    return null;

  // MAIN-world values are cross-compartment wrappers in Firefox. Copy only
  // primitive fields into this isolated world before passing them to extension
  // APIs; forwarding the original arrays can throw on wrapper properties such
  // as `constructor` during WebExtension message serialization.
  const primitive = value => typeof value === 'string' ||
    (typeof value === 'number' && Number.isFinite(value)) ? value : null;
  const ids = new Set();
  const sessions = [];
  for (let i = 0; i < data.sessions.length; i++) {
    const source = data.sessions[i];
    const id = source?.session_id;
    if ((typeof id !== 'string' && !(typeof id === 'number' && Number.isFinite(id))) ||
        !String(id).trim() || String(id).length > 128 || ids.has(String(id))) return null;

    const sourceCandles = source.chart_candles;
    if (!Array.isArray(sourceCandles) || !Number.isSafeInteger(sourceCandles.length) ||
        sourceCandles.length > 3) return null;
    const chart_candles = [];
    for (let j = 0; j < sourceCandles.length; j++) {
      const candle = sourceCandles[j];
      if (!candle || typeof candle !== 'object') return null;
      chart_candles.push({
        date: primitive(candle.date),
        open: primitive(candle.open),
        high: primitive(candle.high),
        low: primitive(candle.low),
        close: primitive(candle.close),
        volume: primitive(candle.volume),
      });
    }
    const session_id = String(id);
    ids.add(session_id);
    sessions.push({session_id, entry_price: primitive(source.entry_price), chart_candles});
  }
  return sessions;
}

export function formatReturnBps(bps) {
  if (!Number.isSafeInteger(bps)) throw new TypeError('Expected integer basis points');
  return `${bps > 0 ? '+' : bps < 0 ? '-' : ''}${(Math.abs(bps) / 100).toFixed(2)}%`;
}

export function renderAnnotations(doc, sessions, results) {
  const grid = doc.querySelector('.q-cards-grid');
  if (!grid) return 0;
  const cards = [...grid.children].filter(card => card.classList.contains('q-chart-card'));
  let visible = 0;
  for (const [index, card] of cards.entries()) {
    let badge = [...card.children].find(child => child.hasAttribute('data-scalp-lookup'));
    const session = sessions[index];
    if (!session) {
      badge?.remove();
      continue;
    }
    if (!badge) {
      badge = doc.createElement('div');
      badge.setAttribute('data-scalp-lookup', '');
      const header = [...card.children].find(child => child.classList.contains('q-card-n'));
      if (header) header.insertAdjacentElement('afterend', badge);
      else card.prepend(badge);
    }
    const result = results.get(String(session.session_id)) || {text: '조회 중…', tone: 'pending'};
    if (badge.textContent !== result.text) badge.textContent = result.text;
    if (badge.getAttribute('data-scalp-tone') !== result.tone)
      badge.setAttribute('data-scalp-tone', result.tone);
    visible++;
  }
  return visible;
}
