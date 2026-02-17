// backend/utils/caseEvents.js
const subscribers = new Map();

function ensureCaseKey(caseId) {
  return String(caseId || "");
}

function addSubscriber(caseId, res) {
  const key = ensureCaseKey(caseId);
  if (!key) return () => {};
  let set = subscribers.get(key);
  if (!set) {
    set = new Set();
    subscribers.set(key, set);
  }
  set.add(res);
  return () => {
    const existing = subscribers.get(key);
    if (!existing) return;
    existing.delete(res);
    if (!existing.size) {
      subscribers.delete(key);
    }
  };
}

function publishCaseEvent(caseId, event, payload = {}) {
  const key = ensureCaseKey(caseId);
  if (!key) return;
  const set = subscribers.get(key);
  if (!set || !set.size) return;
  const data = payload ? JSON.stringify(payload) : "{}";
  const message = `event: ${event}\ndata: ${data}\n\n`;
  set.forEach((res) => {
    try {
      res.write(message);
    } catch {
      set.delete(res);
    }
  });
  if (!set.size) {
    subscribers.delete(key);
  }
}

module.exports = {
  addSubscriber,
  publishCaseEvent,
};
