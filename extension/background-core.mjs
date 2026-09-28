import {LOOKUP_MESSAGE_TYPE} from './quiz-core.mjs';
export {LOOKUP_MESSAGE_TYPE};

export function isQuizPageSender(sender) {
  if (typeof sender?.url !== 'string') return false;
  try {
    const url = new URL(sender.url);
    return url.origin === 'https://scalping.kro.kr' &&
      (url.pathname === '/quiz' || url.pathname.startsWith('/quiz/'));
  } catch {
    return false;
  }
}

export function createLookupHandler(loadDB) {
  return async (message, onStage = () => {}) => {
    onStage('request-validation');
    if (message?.type !== LOOKUP_MESSAGE_TYPE || !Array.isArray(message.lookups) ||
        message.lookups.length > 24 || message.lookups.some(item =>
          typeof item?.id !== 'string' || !item.id || item.id.length > 128 ||
          !Array.isArray(item.bars) || item.bars.length !== 3))
      throw new Error('Invalid Firefox lookup request');

    onStage('db-load');
    const db = await loadDB();
    onStage('fingerprint-lookup');
    const results = await Promise.all(message.lookups.map(async item => {
      const matches = await db.lookup(item.bars);
      if (matches.length === 0) return {id: item.id, status: 'unknown'};
      if (matches.length > 1) return {id: item.id, status: 'ambiguous'};
      const match = matches[0];
      return {id: item.id, status: 'match', match: {
        code: match.code,
        name: match.name,
        lastDate: match.lastDate,
        nextDate: match.nextDate,
        nextReturnBps: match.nextReturnBps,
      }};
    }));
    onStage('response-build');
    return results;
  };
}
