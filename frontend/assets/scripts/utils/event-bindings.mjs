const bindings = new WeakMap();

// Re-rendered controls replace their owned callback without adding another
// writer or disturbing listeners owned by the rest of the page.
export function replaceEventHandler(target, type, listener) {
  let events = bindings.get(target);
  if (!events) { events = new Map(); bindings.set(target, events); }
  const existing = events.get(type);
  if (listener === null) {
    if (existing) target.removeEventListener(type, existing.dispatch);
    events.delete(type);
    return null;
  }
  if (typeof listener !== "function") throw new TypeError("An event callback is required.");
  if (existing) existing.listener = listener;
  else {
    const entry = { listener, dispatch: null };
    entry.dispatch = function(event) {
      if (entry.listener.call(this, event) === false) event.preventDefault();
    };
    events.set(type, entry);
    target.addEventListener(type, entry.dispatch);
  }
  return listener;
}
