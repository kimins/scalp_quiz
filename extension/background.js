// Firefox MV3 runs this as an event page. It loads DB assets in the extension
// origin so page CSP and content-script request rules cannot block local lookup.
(() => {
  'use strict';

  const extensionRuntime = globalThis.browser?.runtime;
  if (!extensionRuntime?.onMessage || !extensionRuntime?.getURL) {
    console.error('[scalp-quiz] Firefox background runtime unavailable');
    return;
  }

  let dbPromise;
  const helperPromise = import(extensionRuntime.getURL('background-core.mjs'));

  function loadDB() {
    if (!dbPromise) {
      dbPromise = import(extensionRuntime.getURL('lookup.mjs'))
        .then(({LookupDB}) => LookupDB.load(extensionRuntime.getURL('db/'), 3))
        .then(db => {
          console.info('[scalp-quiz] DB loaded');
          return db;
        });
    }
    return dbPromise;
  }

  extensionRuntime.onMessage.addListener((message, sender) => {
    if (sender?.id !== extensionRuntime.id || message?.type !== 'SCALP_QUIZ_LOOKUP_BATCH')
      return undefined;
    return helperPromise.then(({createLookupHandler}) => createLookupHandler(loadDB)(message));
  });
})();
