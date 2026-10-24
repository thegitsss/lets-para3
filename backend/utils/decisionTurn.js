// Serialize identical local decisions, never their authority or response. Each
// caller runs its own current-account transaction after the previous turn ends.
// Durable request receipts continue to arbitrate callers in other processes.
const turns = new Map();

module.exports = async function withDecisionTurn(key, work) {
  const prior = turns.get(key) || Promise.resolve();
  let release;
  const turn = new Promise(resolve => { release = resolve; });
  const tail = prior.then(() => turn);
  turns.set(key, tail);
  await prior;
  try { return await work(); }
  finally {
    release();
    if (turns.get(key) === tail) turns.delete(key);
  }
};
