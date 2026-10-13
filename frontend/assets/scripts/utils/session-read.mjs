// Retry only the read that establishes authority, never a write or a rejected account.
export async function readSession(api, { isCurrent = () => true, wait = delay => new Promise(resolve => setTimeout(resolve, delay)), timeoutMs = 10000, signal } = {}) {
  const read = async () => {
    if (signal?.aborted || !isCurrent()) throw new DOMException("Canceled", "AbortError");
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
    try {
      const result = await api.get("/api/auth/me", { signal: controller.signal });
      if (controller.signal.aborted || !isCurrent()) throw new DOMException("Canceled", "AbortError");
      const user = result?.user;
      if (!result || typeof result !== 'object' || Array.isArray(result) || !Object.hasOwn(result, 'user')
        || user !== null && (!user || typeof user !== 'object' || Array.isArray(user)
          || typeof (user.id || user._id) !== 'string' || !(user.id || user._id).trim()
          || typeof user.role !== 'string' || !user.role.trim() || typeof user.status !== 'string' || !user.status.trim())) {
        throw Object.assign(new Error('Your account could not be checked.'), { kind: 'invalid_response', status: 200 });
      }
      return result;
    }
    catch (error) {
      if (timedOut && isCurrent() && !signal?.aborted) {
        throw Object.assign(new Error("The session check timed out."), { kind: "network", status: 0 });
      }
      throw error;
    } finally { clearTimeout(timer); signal?.removeEventListener("abort", abort); }
  };
  try {
    return await read();
  } catch (error) {
    if (error?.name === "AbortError" || error?.kind === "authentication" || error?.kind === "authorization") throw error;
    const transient = error?.kind === "network" || [502, 503, 504].includes(error?.status);
    if (!transient || !isCurrent() || signal?.aborted) throw error;
    await wait(Number.isFinite(error.retryAfterMs) && error.retryAfterMs > 0 ? Math.min(5000, error.retryAfterMs) : 350);
    if (!isCurrent() || signal?.aborted) throw new DOMException("Canceled", "AbortError");
    return read();
  }
}
