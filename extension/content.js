// Runs in the isolated content-script world. Only packaged modules and DB are loaded.
(() => {
  'use strict';

  const extensionRuntime = globalThis.browser?.runtime ?? globalThis.chrome?.runtime;
  if (!extensionRuntime?.getURL) {
    console.error('[scalp-quiz] extension runtime API unavailable');
    return;
  }
  const extensionManifest = extensionRuntime.getManifest?.() || {};
  const firefoxRuntime = Array.isArray(extensionManifest.background?.scripts) &&
    extensionManifest.background.scripts.includes('background.js') ? extensionRuntime : null;
  const extensionURL = path => extensionRuntime.getURL(path);
  const corePromise = import(extensionURL('quiz-core.mjs'));
  const lookupModulePromise = firefoxRuntime ? null : import(extensionURL('lookup.mjs'));
  let dbPromise;
  let generation = 0;
  let currentSessions = [];
  let results = new Map();
  let renderQueued = false;

  function queueRender() {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(async () => {
      renderQueued = false;
      const {renderAnnotations} = await corePromise;
      renderAnnotations(document, currentSessions, results);
    });
  }

  function loadDB() {
    if (!dbPromise) {
      if (!lookupModulePromise) throw new Error('Local lookup is unavailable');
      dbPromise = lookupModulePromise
        .then(({LookupDB}) => LookupDB.load(extensionURL('db/'), 3))
        .then(db => {
          console.info('[scalp-quiz] DB loaded');
          return db;
        });
    }
    return dbPromise;
  }

  async function queryDB(items, lookupMessageType) {
    if (firefoxRuntime) {
      const response = await firefoxRuntime.sendMessage({
        type: lookupMessageType,
        lookups: items.map(({id, bars}) => ({id, bars})),
      });
      if (!Array.isArray(response) || response.length !== items.length)
        throw new Error('Invalid Firefox lookup response');
      return new Map(response.map(item => [String(item.id), item]));
    }

    const db = await loadDB();
    const response = await Promise.all(items.map(async item => {
      const matches = await db.lookup(item.bars);
      if (matches.length === 0) return {id: item.id, status: 'unknown'};
      if (matches.length > 1) return {id: item.id, status: 'ambiguous'};
      const match = matches[0];
      return {id: item.id, status: 'match', match: {
        code: match.code, name: match.name, lastDate: match.lastDate,
        nextDate: match.nextDate, nextReturnBps: match.nextReturnBps,
      }};
    }));
    return new Map(response.map(item => [item.id, item]));
  }

  function resultFromLookup(item, lookup, formatReturnBps, index) {
    if (!item?.bars) {
      if (item?.reason === 'entry-mismatch')
        console.warn(`[scalp-quiz] card ${index + 1}: entry_price differs from last close`);
      return [item.id, {text: item.reason === 'entry-mismatch' ? '가격 불일치' : '미조회',
        tone: item.reason === 'entry-mismatch' ? 'error' : 'unknown'}];
    }
    if (!lookup || lookup.status === 'unknown') return [item.id, {text: '미조회', tone: 'unknown'}];
    if (lookup.status === 'ambiguous') return [item.id, {text: '복수 후보', tone: 'ambiguous'}];
    if (lookup.status !== 'match' || !lookup.match) return [item.id, {text: '미조회', tone: 'unknown'}];
    const match = lookup.match;
    const percent = formatReturnBps(match.nextReturnBps);
    console.info(`[scalp-quiz] ${match.code} ${match.name} ${percent}`);
    return [item.id, {text: `${match.name} | ${percent}`,
      tone: match.nextReturnBps > 0 ? 'positive' : match.nextReturnBps < 0 ? 'negative' : 'zero'}];
  }

  async function captureSessions(sessions) {
    if (!Array.isArray(sessions) || sessions.length > 24) return;
    const mine = ++generation;
    const {normalizeSession, formatReturnBps, LOOKUP_MESSAGE_TYPE} = await corePromise;
    if (mine !== generation) return;
    const normalized = sessions.map(normalizeSession);
    currentSessions = sessions.map(session => ({session_id: session?.session_id}));
    results = new Map();
    console.info(`[scalp-quiz] captured ${sessions.length} sessions`);
    queueRender();

    let lookups = new Map();
    const lookupItems = normalized.filter(item => item?.bars);
    if (lookupItems.length) {
      try {
        lookups = await queryDB(lookupItems, LOOKUP_MESSAGE_TYPE);
      } catch (error) {
        if (mine !== generation) return;
        const failure = normalized.filter(Boolean).map((item, index) =>
          item?.bars ? [item.id, {text: 'DB 오류', tone: 'error'}]
            : resultFromLookup(item, null, formatReturnBps, index));
        results = new Map(failure);
        const detail = String(error?.stack || error?.message || 'unknown error').replace(/moz-extension:\/\/[^/\s]+/g,
          'moz-extension://[extension]').slice(0, 160);
        console.warn(`[scalp-quiz] DB lookup failed: ${detail}`);
        queueRender();
        return;
      }
    }

    const resolved = normalized.map((item, index) => item
      ? resultFromLookup(item, lookups.get(item.id), formatReturnBps, index) : null);
    if (mine !== generation) return;
    results = new Map(resolved.filter(Boolean));
    queueRender();
  }

  window.addEventListener('message', event => {
    corePromise.then(({sessionsFromMessage}) => {
      const sessions = sessionsFromMessage(event, window, location.origin);
      if (sessions) captureSessions(sessions);
    }).catch(() => console.warn('[scalp-quiz] lookup module unavailable'));
  });

  // A GET can recover a round that loaded before the interceptor was installed.
  (async () => {
    const before = generation;
    try {
      const response = await fetch('/api/quiz/state', {
        method: 'GET',
        credentials: 'include',
        cache: 'no-store',
        headers: {Accept: 'application/json'},
      });
      if (!response.ok || !response.headers.get('content-type')?.includes('json')) return;
      const state = await response.json();
      if (generation === before && Array.isArray(state?.sessions)) captureSessions(state.sessions);
    } catch {
      // The page's own state/round response remains available to the hook.
    }
  })();

  const observer = new MutationObserver(queueRender);
  observer.observe(document, {childList: true, subtree: true});
})();
