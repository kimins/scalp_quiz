// Runs in the page's MAIN world before axios initializes. No extension APIs or DB access.
(() => {
  'use strict';

  const TYPE = 'SCALP_QUIZ_SESSIONS';
  const requestMeta = new WeakMap();

  function endpoint(url, method) {
    try {
      const parsed = new URL(String(url), location.href);
      if (parsed.origin !== location.origin) return false;
      return (parsed.pathname === '/api/quiz/state' && method === 'GET') ||
        (parsed.pathname === '/api/quiz/round' && method === 'POST');
    } catch {
      return false;
    }
  }

  function publish(body) {
    if (!body || !Array.isArray(body.sessions) || body.sessions.length > 24) return;
    const sessions = body.sessions.map(session => ({
      session_id: session?.session_id,
      entry_price: session?.entry_price,
      chart_candles: Array.isArray(session?.chart_candles)
        ? session.chart_candles.slice(-3).map(candle => ({
          date: candle?.date,
          open: candle?.open,
          high: candle?.high,
          low: candle?.low,
          close: candle?.close,
          volume: candle?.volume,
        }))
        : [],
    }));
    window.postMessage({type: TYPE, sessions}, location.origin);
  }

  if (typeof window.fetch === 'function') {
    const originalFetch = window.fetch;
    window.fetch = function(input, init) {
      const url = input instanceof Request ? input.url : input;
      const method = String(init?.method || (input instanceof Request ? input.method : 'GET')).toUpperCase();
      const responsePromise = Reflect.apply(originalFetch, this, arguments);
      if (!endpoint(url, method)) return responsePromise;
      return responsePromise.then(response => {
        if (response.ok) response.clone().json().then(publish).catch(() => {});
        return response;
      });
    };
  }

  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function(method, url) {
    requestMeta.set(this, {method: String(method).toUpperCase(), url});
    return Reflect.apply(originalOpen, this, arguments);
  };
  XMLHttpRequest.prototype.send = function() {
    const request = requestMeta.get(this);
    if (request && endpoint(request.url, request.method)) {
      this.addEventListener('loadend', () => {
        if (this.status < 200 || this.status >= 300) return;
        try {
          const body = this.responseType === 'json' ? this.response
            : this.responseType === '' || this.responseType === 'text'
              ? JSON.parse(this.responseText) : null;
          publish(body);
        } catch {
          // A failed or non-JSON response is not a quiz state update.
        }
      }, {once: true});
    }
    return Reflect.apply(originalSend, this, arguments);
  };
})();
