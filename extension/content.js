// Runs in Chrome's isolated world. Only the two packaged modules and DB are loaded.
(() => {
  'use strict';

  const corePromise = import(chrome.runtime.getURL('quiz-core.mjs'));
  const lookupModulePromise = import(chrome.runtime.getURL('lookup.mjs'));
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
      dbPromise = lookupModulePromise
        .then(({LookupDB}) => LookupDB.load(chrome.runtime.getURL('db/'), 3))
        .then(db => {
          console.info('[scalp-quiz] DB loaded');
          return db;
        });
    }
    return dbPromise;
  }

  async function captureSessions(sessions) {
    if (!Array.isArray(sessions) || sessions.length > 24) return;
    const mine = ++generation;
    const {normalizeSession, formatReturnBps} = await corePromise;
    if (mine !== generation) return;
    const normalized = sessions.map(normalizeSession);
    currentSessions = sessions.map(session => ({session_id: session?.session_id}));
    results = new Map();
    console.info(`[scalp-quiz] captured ${sessions.length} sessions`);
    queueRender();

    let db;
    if (normalized.some(item => item?.bars)) {
      try {
        db = await loadDB();
      } catch {
        if (mine !== generation) return;
        results = new Map(normalized.filter(Boolean).map(item =>
          [item.id, {text: 'DB 오류', tone: 'error'}]));
        console.warn('[scalp-quiz] DB load failed');
        queueRender();
        return;
      }
    }

    const resolved = await Promise.all(normalized.map(async (item, index) => {
      if (!item) return null;
      if (!item.bars) {
        if (item.reason === 'entry-mismatch')
          console.warn(`[scalp-quiz] card ${index + 1}: entry_price differs from last close`);
        return [item.id, {text: item.reason === 'entry-mismatch' ? '가격 불일치' : '미조회',
          tone: item.reason === 'entry-mismatch' ? 'error' : 'unknown'}];
      }
      try {
        const matches = await db.lookup(item.bars);
        if (matches.length === 0) return [item.id, {text: '미조회', tone: 'unknown'}];
        if (matches.length > 1) return [item.id, {text: '복수 후보', tone: 'ambiguous'}];
        const match = matches[0];
        const percent = formatReturnBps(match.nextReturnBps);
        console.info(`[scalp-quiz] ${match.code} ${match.name} ${percent}`);
        return [item.id, {text: `${match.name} | ${percent}`,
          tone: match.nextReturnBps > 0 ? 'positive' : match.nextReturnBps < 0 ? 'negative' : 'zero'}];
      } catch {
        return [item.id, {text: '미조회', tone: 'unknown'}];
      }
    }));
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
