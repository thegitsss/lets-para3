import { validReportId } from "./report-status.mjs";

export class HelpError extends Error {
  constructor(message, { status = 0, dispatched = false, authentication = false } = {}) {
    super(message); this.name = "HelpError"; this.status = status; this.dispatched = dispatched; this.authentication = authentication;
  }
}

export function createHelpApi({ api, getIdentity, onSessionLost, verifySession, readMatterContext, fetchImpl = globalThis.fetch.bind(globalThis) }) {
  if (typeof verifySession !== "function") throw new TypeError("A role-specific session verifier is required.");
  const pending = new Set(); let generation = 0;
  const owner = () => String(getIdentity?.()?.id || "");
  async function post(path, payload, { signal, recovery = false } = {}) {
    if (path !== "/api/incidents") throw new TypeError("Invalid Help operation.");
    const ownerId = owner(), ticket = generation;
    if (!/^[a-f0-9]{24}$/i.test(ownerId) || payload?.reporterId !== ownerId) throw new HelpError("Verify your account before sending this report.");
    const controller = new AbortController(), abort = () => controller.abort();
    let timedOut = false, dispatched = false, postDispatchVerificationAttempted = false;
    const timer = setTimeout(() => { timedOut = true; abort(); }, 30000);
    signal?.addEventListener("abort", abort, { once: true }); if (signal?.aborted) abort();
    pending.add(controller);
    const current = () => {
      if (ticket !== generation || signal?.aborted) throw new DOMException("Canceled", "AbortError");
      if (timedOut) throw new HelpError(dispatched ? "LPC did not confirm receipt in time." : "Your account could not be checked in time. No report was sent.", { dispatched });
      if (owner() !== ownerId) { onSessionLost?.(); throw new HelpError("Your signed-in account changed.", { authentication: true, dispatched }); }
    };
    async function verify() {
      if (dispatched) postDispatchVerificationAttempted = true;
      const session = await verifySession({ signal: controller.signal });
      current();
      if (session.state !== "ready" || session.identity.id !== ownerId) { onSessionLost?.(); throw new HelpError("Your signed-in account changed.", { authentication: true, dispatched }); }
    }
    try {
      await verify();
      if (payload.caseId && !recovery) {
        try {
          if (!/^[a-f0-9]{24}$/i.test(payload.caseId)) throw new Error("invalid_context");
          if (typeof readMatterContext !== "function") throw new Error("unsupported_context");
          await readMatterContext(payload.caseId, { ownerId, signal: controller.signal });
          current();
        } catch {
          current();
          throw new HelpError("The related Matter could not be verified. Clear Include this Matter reference to send a general report.");
        }
      }
      const csrf = await api.get("/api/csrf", { signal: controller.signal }); current();
      if (typeof csrf?.csrfToken !== "string" || !csrf.csrfToken) throw new HelpError("The report could not be sent. Please try again.");
      dispatched = true;
      const response = await fetchImpl(path, { method: "POST", credentials: "include", cache: "no-store", redirect: "error",
        signal: controller.signal, headers: { Accept: "application/json", "Content-Type": "application/json", "X-CSRF-Token": csrf.csrfToken }, body: JSON.stringify(payload) });
      const result = await response.json().catch(() => null); current();
      if (!response.ok) {
        if (response.status === 401 || response.status === 403 && ["HELP_REPORTER_CHANGED", "ACCOUNT_CHANGED"].includes(result?.code)) {
          onSessionLost?.(); throw new HelpError("Your signed-in account changed.", { authentication: true, dispatched, status: response.status });
        }
        const failure = new HelpError([400, 422].includes(response.status) ? "Review the summary and description, then try again."
          : response.status === 409 ? "Keep this report’s details and contact LPC if the check continues to fail."
          : "Please try again.", { status: response.status, dispatched });
        if ([400, 422].includes(response.status) && result?.fields && typeof result.fields === "object") {
          failure.payload = { fields: Object.fromEntries(["summary", "description"].filter(key => typeof result.fields[key] === "string" && result.fields[key].length <= 300).map(key => [key, result.fields[key]])) };
        }
        throw failure;
      }
      if (result?.ok !== true || !validReportId(result?.incident?.publicId) || typeof result.reporterAccessToken !== "string" || !result.reporterAccessToken || result.reporterAccessToken.length > 2048) throw new HelpError("LPC did not confirm receipt.", { dispatched });
      await verify(); current();
      return result;
    } catch (error) {
      if (ticket !== generation || signal?.aborted) throw new DOMException("Canceled", "AbortError");
      // A refused or lost response can follow a cookie change just as a valid
      // receipt can. Recheck before retaining private error feedback, without
      // treating an unavailable check as proof that the account changed.
      if (dispatched && !postDispatchVerificationAttempted && !error?.authentication && !controller.signal.aborted) {
        try { await verify(); }
        catch (verificationError) {
          if (ticket !== generation || signal?.aborted) throw new DOMException("Canceled", "AbortError");
          if (verificationError?.authentication) throw verificationError;
          throw new HelpError("LPC did not confirm receipt. Please try again.", { dispatched });
        }
      }
      if (ticket !== generation || signal?.aborted) throw new DOMException("Canceled", "AbortError");
      if (error instanceof HelpError) throw error;
      throw new HelpError(dispatched ? "LPC did not confirm receipt. Please try again." : "Your account could not be checked. No report was sent.", { dispatched });
    } finally { clearTimeout(timer); pending.delete(controller); signal?.removeEventListener("abort", abort); }
  }
  return Object.freeze({ get: (...args) => api.get(...args), post, clear() { generation++; pending.forEach(controller => controller.abort()); pending.clear(); } });
}
