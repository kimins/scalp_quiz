export const MESSAGE_TYPE = 'SCALP_QUIZ_SESSIONS';
export const LOOKUP_MESSAGE_TYPE = 'SCALP_QUIZ_LOOKUP_BATCH';

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
  if (!data || data.type !== MESSAGE_TYPE || !Array.isArray(data.sessions) || data.sessions.length > 24)
    return null;
  const ids = new Set();
  for (const session of data.sessions) {
    const id = session?.session_id;
    if ((typeof id !== 'string' && typeof id !== 'number') || !String(id).trim() ||
        String(id).length > 128 || ids.has(String(id)) ||
        !Array.isArray(session.chart_candles) || session.chart_candles.length > 3) return null;
    ids.add(String(id));
  }
  return data.sessions;
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
