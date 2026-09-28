// Firefox MV3 runs this as a non-persistent event page. The Firefox package
// declares it as a module so its local dependencies load before listeners run.
import {LookupDB} from './lookup.mjs';
import {createLookupHandler, isQuizPageSender} from './background-core.mjs';
import {decodeLookupRequest, encodeLookupResponse, LOOKUP_ERROR_TYPE,
  LOOKUP_MESSAGE_TYPE} from './quiz-core.mjs';

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
  function reportFailure(sendResponse, stage, error) {
    const name = String(error?.name || 'Error').slice(0, 48);
    const message = String(error?.message || 'Unknown error')
      .replace(/moz-extension:\/\/[^/\s]+/g, 'moz-extension://[extension]').slice(0, 240);
    console.warn(`[scalp-quiz] background lookup failed stage=${stage}: ${message}`);
    sendResponse({type: LOOKUP_ERROR_TYPE, stage, name, message});
  }

  extensionRuntime.onMessage.addListener((message, sender, sendResponse) => {
    // Firefox may expose an internal UUID as sender.id. Runtime onMessage is
    // extension-local, so constrain this request by the exact quiz page URL.
    if (message?.type !== LOOKUP_MESSAGE_TYPE || !isQuizPageSender(sender)) return undefined;

    let request;
    try {
      request = decodeLookupRequest(message);
    } catch (error) {
      reportFailure(sendResponse, 'request-decode', error);
      return false;
    }

    let stage = 'request-validation';
    handleLookup(request, nextStage => { stage = nextStage; }).then(results => {
      stage = 'response-encode';
      const response = encodeLookupResponse(results);
      stage = 'response-send';
      sendResponse(response);
    }).catch(error => reportFailure(sendResponse, stage, error));
    // Callback response style keeps Firefox event-page messaging compatible
    // without returning a cross-compartment Promise or nested object graph.
    return true;
  });
}
