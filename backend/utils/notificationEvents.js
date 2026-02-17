// backend/utils/notificationEvents.js
const subscribers = new Map();

function normalizeUserId(userId) {
  return String(userId || "");
}

function addSubscriber(userId, res) {
  const key = normalizeUserId(userId);
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

function publishNotificationEvent(userId, event = "notifications", payload = {}) {
  const key = normalizeUserId(userId);
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
  publishNotificationEvent,
};
