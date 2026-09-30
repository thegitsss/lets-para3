const KEY = 'lpc_account_closure_result';
const valid = value => typeof value === 'string' && value.length <= 2048 && /^[A-Za-z0-9_-]+\.[a-f0-9]{64}$/.test(value);

// Only a short-lived, purpose-limited status capability is retained. No
// credential, profile, confirmation text or automatic mutation is stored.
export function readClosureProof(storage) {
  try {
    storage ||= globalThis.sessionStorage;
    const value = storage.getItem(KEY);
    if (valid(value)) return value;
    if (value) storage.removeItem(KEY);
  } catch { /* The caller presents a safe unavailable state. */ }
  return null;
}

export function storeClosureProof(value, storage = globalThis.sessionStorage) {
  if (!valid(value)) throw new Error('Account check could not be retained.');
  storage.setItem(KEY, value);
  if (storage.getItem(KEY) !== value) throw new Error('Account check could not be retained.');
}

export function clearClosureProof(storage) {
  try { (storage || globalThis.sessionStorage).removeItem(KEY); } catch { /* Read-only expiry still applies. */ }
}
