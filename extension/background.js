// Firefox MV3 runs this as a non-persistent event page. The Firefox package
// declares it as a module so its local dependencies load before listeners run.
import {LookupDB} from './lookup.mjs';
import {createLookupHandler, isQuizPageSender, LOOKUP_MESSAGE_TYPE} from './background-core.mjs';

const extensionRuntime = globalThis.browser?.runtime;
if (!extensionRuntime?.onMessage || !extensionRuntime?.getURL) {
  console.error('[scalp-quiz] Firefox background runtime unavailable');
} else {
  let dbPromise;

  function loadDB() {
    if (!dbPromise) {
      dbPromise = LookupDB.load(extensionRuntime.getURL('db/'), 3).then(db => {
        console.info('[scalp-quiz] DB loaded');
        return db;
      }).catch(error => {
        dbPromise = null;
        throw error;
      });
    }
    return dbPromise;
  }

  const handleLookup = createLookupHandler(loadDB);
  extensionRuntime.onMessage.addListener((message, sender) => {
    // Firefox may expose an internal UUID as sender.id. Runtime onMessage is
    // extension-local, so constrain this request by the exact quiz page URL.
    if (message?.type !== LOOKUP_MESSAGE_TYPE || !isQuizPageSender(sender)) return undefined;
    return handleLookup(message);
  });
}
