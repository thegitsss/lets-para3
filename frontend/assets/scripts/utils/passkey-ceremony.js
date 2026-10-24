export async function runPasskeyCeremony(start, { cancel, timeoutMs = 60000, action = "setup" } = {}) {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error(`Your browser did not complete passkey ${action}. Open this page in a regular Chrome or Safari tab and try again.`);
      error.name = "PasskeyTimeoutError";
      reject(error);
      try { cancel?.(); } catch { /* Report the deadline even if the browser cannot abort. */ }
    }, timeoutMs);
  });
  try { return await Promise.race([start(), deadline]); }
  finally { clearTimeout(timer); }
}

export async function runPasskeyRequest(operation, { timeoutMs = 30000, mutating = false } = {}) {
  const controller = new AbortController();
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error(mutating
        ? "The passkey change could not be confirmed. Check your passkeys before trying again."
        : "The passkey request timed out. Please try again.");
      error.name = "PasskeyRequestTimeoutError"; error.kind = mutating ? "uncertain" : "request";
      reject(error); controller.abort();
    }, timeoutMs);
  });
  try { return await Promise.race([operation(controller.signal), deadline]); }
  finally { clearTimeout(timer); }
}

// Password proof and device approval are separate actions. The device request
// starts directly from the second click, with no network work before it.
export function createPasskeyEnrollment({ begin, save, start, cancelNative, onPhase = () => {}, now = Date.now }) {
  let phase = "password", registration = null, expiresAt = 0, generation = 0;
  const update = value => { phase = value; onPhase(value); };
  const canceled = () => new DOMException("Passkey setup canceled.", "AbortError");
  const current = ticket => { if (ticket !== generation || phase === "closed") throw canceled(); };
  return Object.freeze({
    get phase() { return phase; },
    async prepare(password) {
      if (phase !== "password") return;
      const ticket = ++generation;
      update("preparing");
      try {
        const value = await begin(password);
        current(ticket);
        if (!value?.challengeId || !value?.options?.challenge) throw new Error("Unable to prepare passkey setup. Please try again.");
        registration = value; expiresAt = now() + 240000; update("ready");
      } catch (error) {
        if (ticket !== generation || phase === "closed") throw canceled();
        registration = null; update("password"); throw error;
      }
    },
    async create(name = "Passkey") {
      if (phase !== "ready") return;
      if (now() >= expiresAt) { registration = null; update("password"); throw new Error("Passkey setup expired. Enter your current password to start again."); }
      const ticket = generation;
      update("device");
      try {
        const response = await runPasskeyCeremony(() => start(registration.options), { cancel: cancelNative });
        current(ticket); update("saving");
        const saved = await save({ challengeId: registration.challengeId, response, name: String(name).trim() || "Passkey" });
        current(ticket); registration = null; update("saved"); return saved;
      } catch (error) {
        if (ticket !== generation || phase === "closed") throw canceled();
        if (phase === "saving") { registration = null; update("password"); }
        else update("ready");
        throw error;
      }
    },
    cancel() {
      if (phase === "saving" || phase === "saved" || phase === "closed") return false;
      const devicePending = phase === "device";
      generation += 1; registration = null; update("closed");
      if (devicePending) { try { cancelNative?.(); } catch { /* The closed flow cannot submit a late credential. */ } }
      return true;
    },
  });
}
