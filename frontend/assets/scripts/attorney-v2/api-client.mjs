import { classifySession } from "./session-boundary.mjs";
import { draftValues, validDraftId } from "../matter-draft-contract.mjs";
import { createWorkspacePresenceLease } from "../utils/workspace-presence-lease.mjs";
import { assertDocumentActive } from "../utils/document-navigation.mjs";

export class ApiError extends Error {
  constructor(kind, status = 0, code) {
    super("The workspace request could not be completed.");
    this.code = typeof code === "string" && /^(?:POSTING|PUBLICATION|DRAFT|NOTE|SAVED_VIEW|SAVED_PARALEGAL|MODERATION|INVITATION|ARCHIVE|DOWNLOAD|RECEIPT|EXPORT|APPLICATION_(?:REVIEW|ACCOUNT|SOURCE)|PRE_ENGAGEMENT|PAYMENT_SETUP|HIRING|HIRE|WORKSPACE|DOCUMENT|FILE|FINANCIAL)_[A-Z_]{1,60}$/.test(code) ? code : undefined;
    this.name = "ApiError";
    this.kind = kind;
    this.status = status;
  }
}

export function safeApiPath(value) {
  if (typeof value !== "string" || !value.startsWith("/api/") || /[\\\x00-\x20#]/.test(value)) throw new TypeError("Expected an API path.");
  const pathname = value.split("?")[0];
  let decoded;
  try { decoded = decodeURIComponent(pathname); } catch { throw new TypeError("Invalid API path."); }
  if (decoded.split("/").some((part) => part === "." || part === "..") || /[\\%]/.test(decoded)) throw new TypeError("Invalid API path.");
  return value;
}

// Fixed operations only. Private writes verify the account again and never retry.
export function createApiClient({ fetchImpl = window.fetch.bind(window), onAuthenticationLost } = {}) {
  const pending = new Set();
  const presenceLeases = new Map();
  let generation = 0;
    async function request(path, { signal, method = "GET", body, headers = {}, binary = false } = {}) {
      assertDocumentActive();
      const url = safeApiPath(path);
      const controller = new AbortController();
      const ticket = generation;
      const abort = () => controller.abort();
      pending.add(controller);
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
      try {
        const response = await fetchImpl(url, {
          method, credentials: "include", cache: "no-store", redirect: "error", body,
          headers: { Accept: "application/json", ...headers }, signal: controller.signal,
        });
        let payload;
        if (binary && response.ok) {
          const contentType = binary === true ? "application/octet-stream" : binary;
          if (response.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== contentType) throw new ApiError("invalid_response", response.status);
          payload = await response.blob();
          if (contentType === "application/pdf" && await payload.slice(0, 5).text() !== "%PDF-") throw new ApiError("invalid_response", response.status);
          if (contentType === "application/zip") {
            const [header, footer] = await Promise.all([payload.slice(0, 4).arrayBuffer(), payload.slice(-22).arrayBuffer()]);
            const starts = (value, signature) => signature.every((byte, index) => new Uint8Array(value)[index] === byte);
            if (payload.size > 270 * 1024 * 1024 || !starts(header, [80, 75, 3, 4]) || !starts(footer, [80, 75, 5, 6])) throw new ApiError("invalid_response", response.status);
          }
        } else payload = await response.json().catch(() => null);
        if (ticket !== generation || controller.signal.aborted) throw new DOMException("Canceled", "AbortError");
        if (!response.ok) {
          const message = String(payload?.msg || payload?.error || "");
          if (response.status === 403 && payload?.code === "ACCOUNT_CHANGED") {
            onAuthenticationLost?.();
            throw new ApiError("authentication", response.status);
          }
          const lost = response.status === 401 || (response.status === 403 && (["WORKSPACE_FUNDING_ACCOUNT_CHANGED", "WORKSPACE_WITHDRAWAL_ACCOUNT_CHANGED", "FILE_WRITE_ACCOUNT_CHANGED", "FILE_REMOVAL_ACCOUNT_CHANGED", "WORKSPACE_DISPUTE_ACCOUNT_CHANGED", "WORKSPACE_COMPLETION_ACCOUNT_CHANGED", "DOCUMENT_ACCOUNT_CHANGED", "WORKSPACE_ACCOUNT_CHANGED", "HIRING_ACCOUNT_CHANGED", "PAYMENT_SETUP_ACCOUNT_CHANGED", "APPLICATION_REVIEW_ACCOUNT_CHANGED", "APPLICATION_ACCOUNT_CHANGED", "DRAFT_ACCOUNT_CHANGED", "NOTE_ACCOUNT_CHANGED", "SAVED_VIEW_ACCOUNT_CHANGED", "SAVED_PARALEGAL_ACCOUNT_CHANGED", "MODERATION_ACCOUNT_CHANGED", "INVITATION_ACCOUNT_CHANGED", "ARCHIVE_ACCOUNT_CHANGED", "DOWNLOAD_ACCOUNT_CHANGED", "RECEIPT_ACCOUNT_CHANGED", "EXPORT_ACCOUNT_CHANGED"].includes(payload?.code) || /session expired|invalid token|account has been (?:deactivated|disabled)/i.test(message)));
          if (lost) onAuthenticationLost?.();
          const failure = new ApiError(lost ? "authentication" : response.status === 403 ? "authorization" : "request", response.status, payload?.code);
          const retryAfter = Number(response.headers.get('retry-after'));
          if (response.status === 503 && Number.isFinite(retryAfter) && retryAfter > 0) failure.retryAfterMs = Math.min(5000, retryAfter * 1000);
          throw failure;
        }
        if (payload === null) throw new ApiError("invalid_response", response.status);
        return payload;
      } catch (error) {
        if (error.name === "AbortError" || error instanceof ApiError) throw error;
        throw new ApiError("network");
      } finally {
        pending.delete(controller);
        signal?.removeEventListener("abort", abort);
      }
    }
  async function privateWrite(path, method, body, { signal, ownerId, headers = {} } = {}) {
    const ticket = generation;
    if (!/^[a-f0-9]{24}$/i.test(ownerId || "")) throw new ApiError("authentication");
    const session = classifySession(await request("/api/auth/me", { signal }));
    if (session.state !== "ready" || session.identity.id !== ownerId) {
      onAuthenticationLost?.();
      throw new ApiError("authentication");
    }
    const csrf = await request("/api/csrf", { signal });
    if (signal?.aborted || ticket !== generation) throw new DOMException("Canceled", "AbortError");
    if (typeof csrf.csrfToken !== "string" || !csrf.csrfToken) throw new ApiError("invalid_response");
    return request(path, { signal, method, body: JSON.stringify(body), headers: { ...headers, "Content-Type": "application/json", "X-CSRF-Token": csrf.csrfToken } });
  }
  const taskPath = (id) => {
    if (!/^[a-f0-9]{24}$/i.test(id || "")) throw new TypeError("Invalid task ID.");
    return `/api/checklist/${id}`;
  };
  const draftPath = (id) => {
    if (!validDraftId(id)) throw new TypeError("Invalid draft ID.");
    return `/api/case-drafts/${id}`;
  };
  async function verifyDownloadOwner({ signal, ownerId } = {}) {
    const ticket = generation, session = classifySession(await request("/api/auth/me", { signal }));
    if (session.state !== "ready" || session.identity.id !== ownerId) { onAuthenticationLost?.(); throw new ApiError("authentication"); }
    if (signal?.aborted || ticket !== generation) throw new DOMException("Canceled", "AbortError");
  }
  async function paymentRead(path, options) {
    await verifyDownloadOwner(options);
    const value = await request(`${path}?expectedOwnerId=${encodeURIComponent(options.ownerId)}`, options);
    await verifyDownloadOwner(options); return value;
  }
  async function workspaceRead(path, options) {
    const controller = new AbortController(), cancel = () => controller.abort();
    options.signal?.addEventListener("abort", cancel, { once: true });
    if (options.signal?.aborted) cancel();
    const timer = setTimeout(cancel, 30000), checked = { ...options, signal: controller.signal };
    try {
      await verifyDownloadOwner(checked);
      const value = await request(path, checked);
      await verifyDownloadOwner(checked); return value;
    } finally { clearTimeout(timer); options.signal?.removeEventListener("abort", cancel); }
  }
  async function workspaceWrite(path, method, body, options) {
    const controller = new AbortController(), cancel = () => controller.abort();
    options.signal?.addEventListener("abort", cancel, { once: true });
    if (options.signal?.aborted) cancel();
    const timer = setTimeout(cancel, 30000), checked = { ...options, signal: controller.signal };
    try { const result = await privateWrite(path, method, { ...body, expectedOwnerId: options.ownerId }, checked); await verifyDownloadOwner(checked); return result; }
    finally { clearTimeout(timer); options.signal?.removeEventListener("abort", cancel); }
  }
  async function paymentWrite(path, method, body, options) {
    const value = await privateWrite(path, method, { ...body, expectedOwnerId: options.ownerId }, options);
    await verifyDownloadOwner(options); return value;
  }
  function financialQuery(options) {
    const query = new URLSearchParams({ expectedOwnerId: options.ownerId });
    for (const key of ["view", "q", "caseId", "cursor", "revision"]) if (options[key] !== undefined && options[key] !== null) query.set(key, options[key]);
    return query;
  }
  return Object.freeze({
    readDraftDefaults: options => workspaceRead(`/api/case-drafts/defaults?expectedOwnerId=${encodeURIComponent(options.ownerId)}`, options),
    suggestMatterDraft: (brief, options) => workspaceWrite("/api/case-drafts/suggest", "POST", {brief, practiceArea:options.practiceArea || "", state:options.state || "", ...(options.current?{current:options.current}:{}), ...(options.update?{update:options.update}:{})}, options),
    mutateNotification: (path, method, options) => {
      const allowed = method === "POST" && /^\/api\/notifications\/(?:read-all|[a-f\d]{24}\/(?:read|unread))$/i.test(path)
        || method === "DELETE" && /^\/api\/notifications(?:\/[a-f\d]{24})?$/i.test(path);
      if (!allowed) throw new TypeError("Invalid notification operation.");
      return privateWrite(path, method, { expectedOwnerId: options?.ownerId }, options);
    },
    readWithdrawal: (caseId, options) => {
      if (!validDraftId(caseId)) throw new TypeError("Invalid Matter.");
      const query = new URLSearchParams({ expectedOwnerId: options.ownerId }); if (options.requestId) query.set("requestId", options.requestId);
      return workspaceRead(`/api/cases/${caseId}/withdrawal-review?${query}`, options);
    },
    readFunding: (caseId, options) => {
      if (!validDraftId(caseId)) throw new TypeError("Invalid Matter.");
      const query = new URLSearchParams({ expectedOwnerId: options.ownerId }); if (options.requestId) query.set("requestId", options.requestId);
      return workspaceRead(`/api/payments/matter/${caseId}/funding?${query}`, options);
    },
    writeFunding: (caseId, body, options) => {
      if (!validDraftId(caseId)) throw new TypeError("Invalid Matter.");
      return workspaceWrite(`/api/payments/matter/${caseId}/funding`, "POST", body, options);
    },
    readCheckout: (caseId, options) => {
      if (!validDraftId(caseId)) throw new TypeError("Invalid Matter.");
      return workspaceRead(`/api/payments/matter/${caseId}/checkout?${new URLSearchParams({ expectedOwnerId: options.ownerId })}`, options);
    },
    resumeCheckout: (caseId, reviewedRevision, options) => {
      if (!validDraftId(caseId)) throw new TypeError("Invalid Matter.");
      return workspaceWrite(`/api/payments/matter/${caseId}/checkout/resume`, "POST", { reviewedRevision }, options);
    },
    writeWithdrawal: (caseId, body, options) => {
      if (!validDraftId(caseId)) throw new TypeError("Invalid Matter.");
      return workspaceWrite(`/api/cases/${caseId}/withdrawal-decision`, "POST", body, options);
    },
    readFinancialHistory: options => workspaceRead(`/api/payments/attorney-financial-history?${financialQuery(options)}`, options),
    async downloadFinancialCsv(revision, options) {
      if (!/^[a-f0-9]{64}$/.test(revision || "")) throw new TypeError("Invalid financial history review.");
      const ticket = generation;
      await verifyDownloadOwner(options);
      const blob = await request(`/api/payments/attorney-financial-history/csv?${financialQuery({ ...options, cursor: undefined, revision })}`, { signal: options.signal, binary: "text/csv", headers: { Accept: "text/csv" } });
      if (blob.size > 32 * 1024 * 1024 || !(await blob.slice(0, 100).text()).replace(/^\uFEFF/, "").startsWith('"Matter","Record","Status","Currency","Amount",')) throw new ApiError("invalid_response");
      await verifyDownloadOwner(options);
      if (options.signal?.aborted || ticket !== generation) throw new DOMException("Canceled", "AbortError");
      return blob;
    },
    readReceivedApplications: options => workspaceRead(`/api/applications/my-postings?expectedOwnerId=${encodeURIComponent(options.ownerId)}`, options),
    readWorkspaceMatter: (caseId, options) => {
      if (!validDraftId(caseId)) throw new TypeError("Invalid Matter.");
      return workspaceRead(`/api/cases/${caseId}?expectedOwnerId=${encodeURIComponent(options.ownerId)}`, options);
    },
    readCompletion: (caseId, options) => {
      if (!validDraftId(caseId)) throw new TypeError("Invalid Matter completion.");
      const query = new URLSearchParams({ expectedOwnerId: options.ownerId }); if (options.requestId) query.set("requestId", options.requestId);
      return workspaceRead(`/api/cases/${caseId}/completion-review?${query}`, options);
    },
    readDisputes: (caseId, options) => {
      if (!validDraftId(caseId)) throw new TypeError("Invalid Matter dispute.");
      const query = new URLSearchParams({ expectedOwnerId: options.ownerId });
      for (const key of ["cursor", "disputeId", "commentCursor", "commentId", "requestId"]) if (options[key]) query.set(key, options[key]);
      return workspaceRead(`/api/disputes/${caseId}/attorney-review?${query}`, options);
    },
    recordDispute: (caseId, input, options) => {
      if (!validDraftId(caseId)) throw new TypeError("Invalid Matter dispute.");
      return paymentWrite(`/api/disputes/${caseId}/attorney-action`, "POST", input, options);
    },
    completeMatter: (caseId, input, options) => {
      if (!validDraftId(caseId)) throw new TypeError("Invalid Matter completion.");
      return paymentWrite(`/api/cases/${caseId}/complete`, "POST", input, options);
    },
    readWorkspaceWork: (caseId, options) => {
      if (!validDraftId(caseId)) throw new TypeError("Invalid Matter work.");
      return workspaceRead(`/api/cases/${caseId}/work-review?expectedOwnerId=${encodeURIComponent(options.ownerId)}`, options);
    },
    readWorkspaceRemoval: (caseId, fileId, options) => {
      if (!validDraftId(caseId) || !validDraftId(fileId)) throw new TypeError("Invalid document removal.");
      const query = new URLSearchParams({ expectedOwnerId: options.ownerId }); if (options.requestId) query.set("requestId", options.requestId);
      return workspaceRead(`/api/uploads/case/${caseId}/removal-review/${fileId}?${query}`, options);
    },
    removeWorkspaceFile: (caseId, fileId, input, options) => {
      if (!validDraftId(caseId) || !validDraftId(fileId)) throw new TypeError("Invalid document removal.");
      return paymentWrite(`/api/uploads/case/${caseId}/reviewed-removal/${fileId}`, "POST", input, options);
    },
    readWorkspaceReplacement: (caseId, fileId, options) => {
      if (!validDraftId(caseId) || !validDraftId(fileId)) throw new TypeError("Invalid replacement document.");
      const query = new URLSearchParams({ expectedOwnerId: options.ownerId }); if (options.requestId) query.set("requestId", options.requestId);
      return workspaceRead(`/api/uploads/case/${caseId}/replacement-review/${fileId}?${query}`, options);
    },
    async replaceWorkspaceFile(caseId, fileId, input, options) {
      if (!validDraftId(caseId) || !validDraftId(fileId)) throw new TypeError("Invalid replacement document.");
      const ticket = generation; await verifyDownloadOwner(options);
      const csrf = await request("/api/csrf", options);
      if (typeof csrf.csrfToken !== "string" || !csrf.csrfToken) throw new ApiError("invalid_response");
      if (options.signal?.aborted || ticket !== generation) throw new DOMException("Canceled", "AbortError");
      const body = new FormData(); body.set("expectedOwnerId", options.ownerId); body.set("requestId", input.requestId); body.set("reviewedRevision", input.reviewedRevision); body.set("reviewedFileRevision", input.reviewedFileRevision); body.set("file", input.file, input.file.name);
      const value = await request(`/api/uploads/case/${caseId}/reviewed-replacement/${fileId}`, { signal: options.signal, method: "POST", body, headers: { "X-CSRF-Token": csrf.csrfToken } });
      await verifyDownloadOwner(options); return value;
    },
    readWorkspaceUpload: (caseId, options) => {
      if (!validDraftId(caseId)) throw new TypeError("Invalid Matter upload.");
      const query = new URLSearchParams({ expectedOwnerId: options.ownerId });
      if (options.requestId) query.set("requestId", options.requestId);
      return workspaceRead(`/api/uploads/case/${caseId}/upload-review?${query}`, options);
    },
    async uploadWorkspaceFile(caseId, input, options) {
      if (!validDraftId(caseId)) throw new TypeError("Invalid Matter upload.");
      const ticket = generation; await verifyDownloadOwner(options);
      const csrf = await request("/api/csrf", options);
      if (typeof csrf.csrfToken !== "string" || !csrf.csrfToken) throw new ApiError("invalid_response");
      if (options.signal?.aborted || ticket !== generation) throw new DOMException("Canceled", "AbortError");
      const body = new FormData(); body.set("expectedOwnerId", options.ownerId); body.set("requestId", input.requestId); body.set("reviewedRevision", input.reviewedRevision); body.set("file", input.file, input.file.name);
      const value = await request(`/api/uploads/case/${caseId}/reviewed-upload`, { signal: options.signal, method: "POST", body, headers: { "X-CSRF-Token": csrf.csrfToken } });
      await verifyDownloadOwner(options); return value;
    },
    readEarlierFiles: (caseId, options) => {
      if (!validDraftId(caseId)) throw new TypeError("Invalid earlier Matter files.");
      const query = new URLSearchParams({ expectedOwnerId: options.ownerId });
      for (const key of ["cursor", "revision", "referenceId"]) if (options[key] !== null && options[key] !== undefined && options[key] !== "") query.set(key, options[key]);
      return workspaceRead(`/api/cases/${caseId}/earlier-files?${query}`, options);
    },
    async downloadEarlierFile(caseId, referenceId, revision, options) {
      if (!validDraftId(caseId) || !/^[a-f0-9]{64}$/.test(referenceId || "") || !/^[a-f0-9]{64}$/.test(revision || "")) throw new TypeError("Invalid earlier Matter file.");
      await verifyDownloadOwner(options);
      const value = await request(`/api/cases/${caseId}/earlier-files/${referenceId}/download?${new URLSearchParams({ expectedOwnerId: options.ownerId, revision })}`, { signal: options.signal, binary: true });
      await verifyDownloadOwner(options); return value;
    },
    readWorkspaceFileHistory: (caseId, fileId, reviewedRevision, options) => {
      if (!validDraftId(caseId) || !validDraftId(fileId) || !/^[a-f0-9]{64}$/.test(reviewedRevision || "")) throw new TypeError("Invalid document history.");
      const query = new URLSearchParams({ expectedOwnerId: options.ownerId, reviewedRevision });
      for (const key of ["cursor", "responseCursor"]) if (options[key] !== null && options[key] !== undefined) query.set(key, options[key]);
      return workspaceRead(`/api/cases/${caseId}/files/${fileId}/history?${query}`, options);
    },
    async downloadWorkspaceFileHistory(caseId, fileId, index, revision, options) {
      if (!validDraftId(caseId) || !validDraftId(fileId) || !Number.isSafeInteger(index) || index < 0 || !/^[a-f0-9]{64}$/.test(revision || "")) throw new TypeError("Invalid earlier document.");
      await verifyDownloadOwner(options);
      const value = await request(`/api/cases/${caseId}/files/${fileId}/history/${index}/download?${new URLSearchParams({expectedOwnerId: options.ownerId, revision})}`, {signal: options.signal, binary: true});
      await verifyDownloadOwner(options); return value;
    },
    readWorkspaceFiles: (caseId, options) => {
      if (!validDraftId(caseId)) throw new TypeError("Invalid Matter files.");
      const query = new URLSearchParams({ expectedOwnerId: options.ownerId });
      for (const key of ["cursor", "fileId"]) if (options[key]) { if (!validDraftId(options[key])) throw new TypeError("Invalid file selection."); query.set(key, options[key]); }
      return workspaceRead(`/api/cases/${caseId}/files/review?${query}`, options);
    },
    updateWorkspaceFile: (caseId, fileId, selection, options) => {
      if (!validDraftId(caseId) || !validDraftId(fileId)) throw new TypeError("Invalid document review.");
      return workspaceWrite(`/api/cases/${caseId}/files/${fileId}/review`, "POST", selection, options);
    },
    updateWorkspaceWork: (caseId, index, completed, reviewedRevision, options) => {
      if (!validDraftId(caseId) || !Number.isSafeInteger(index) || index < 0 || typeof completed !== "boolean") throw new TypeError("Invalid work selection.");
      return workspaceWrite(`/api/cases/${caseId}/work-review`, "POST", { index, completed, reviewedRevision }, options);
    },
    readWorkspaceHistory: (caseId, options) => {
      if (!validDraftId(caseId)) throw new TypeError("Invalid Matter history.");
      return workspaceRead(`/api/cases/${caseId}/status-history`, options);
    },
    readWorkspaceDates: (caseId, options) => {
      if (!validDraftId(caseId)) throw new TypeError("Invalid Matter calendar.");
      const query = new URLSearchParams({ expectedOwnerId: options.ownerId });
      for (const key of ["cursor", "eventId", "from", "to", "requestId"]) if (options[key]) query.set(key, options[key]);
      return workspaceRead(`/api/events/matters/${caseId}/review?${query}`, options);
    },
    saveWorkspaceDate: (caseId, review, options) => {
      if (!validDraftId(caseId)) throw new TypeError("Invalid Matter calendar.");
      return workspaceWrite(`/api/events/matters/${caseId}/reviewed-action`, "POST", review, options);
    },
    readWorkspaceMessages: (caseId, options) => {
      if (!validDraftId(caseId)) throw new TypeError("Invalid Matter messages.");
      const query = new URLSearchParams({ expectedOwnerId: options.ownerId });
      for (const key of ["cursor", "messageId", "clientMessageId"]) if (options[key]) query.set(key, options[key]);
      return workspaceRead(`/api/messages/${caseId}?${query}`, options);
    },
    readRetainedMessages: (caseId, options) => {
      if (!validDraftId(caseId)) throw new TypeError("Invalid retained Matter messages.");
      const query = new URLSearchParams({ expectedOwnerId: options.ownerId });
      for (const key of ["cursor", "messageId"]) if (options[key]) query.set(key, options[key]);
      return workspaceRead(`/api/cases/${caseId}/retained-messages?${query}`, options);
    },
    readPaymentRecords: options => {
      const query = new URLSearchParams({ expectedOwnerId: options.ownerId });
      for (const key of ["view", "q", "cursor", "caseId"]) if (options[key]) query.set(key, options[key]);
      return workspaceRead(`/api/payments/attorney-records?${query}`, options);
    },
    openAttorneyBilling: (requestId, options) => workspaceWrite("/api/payments/portal/attorney", "POST", { requestId }, options),
    async downloadMessageAttachment(caseId, messageId, revision, { signal, ownerId, retained = false, attachmentId } = {}) {
      if (!validDraftId(caseId) || !validDraftId(messageId) || !/^[a-f0-9]{64}$/.test(revision || "")) throw new TypeError("Invalid message attachment.");
      const ticket = generation;
      await verifyDownloadOwner({ signal, ownerId });
      if (ticket !== generation || signal?.aborted) throw new DOMException("Canceled", "AbortError");
      if (attachmentId !== undefined && !/^(primary|file-(0|[1-9]\d{0,5}))$/.test(attachmentId)) throw new TypeError("Invalid attachment selection.");
      const blob = await request(`/api/cases/${caseId}/message-attachments/${messageId}?${new URLSearchParams({ expectedOwnerId: ownerId, revision, ...(retained ? { retained: "true" } : {}), ...(attachmentId ? { attachmentId } : {}) })}`, { signal, binary: true, headers: { Accept: "application/octet-stream" } });
      if (blob.size > 25 * 1024 * 1024) throw new ApiError("invalid_response");
      await verifyDownloadOwner({ signal, ownerId });
      if (ticket !== generation || signal?.aborted) throw new DOMException("Canceled", "AbortError");
      return blob;
    },
    async prepareMessageAudio(caseId, messageId, revision, options = {}) {
      if (!validDraftId(caseId) || !validDraftId(messageId) || !/^[a-f0-9]{64}$/.test(revision || "")) throw new TypeError("Invalid audio message.");
      const ticket = generation; await verifyDownloadOwner(options);
      if (ticket !== generation || options.signal?.aborted) throw new DOMException("Canceled", "AbortError");
      if (options.attachmentId !== undefined && !/^(primary|file-(0|[1-9]\d{0,5}))$/.test(options.attachmentId)) throw new TypeError("Invalid attachment selection.");
      return `/api/cases/${caseId}/message-attachments/${messageId}?${new URLSearchParams({ expectedOwnerId: options.ownerId, revision, play: "true", ...(options.retained ? { retained: "true" } : {}), ...(options.attachmentId ? { attachmentId: options.attachmentId } : {}) })}`;
    },
    sendWorkspaceMessage: (caseId, text, clientMessageId, options) => {
      if (!validDraftId(caseId)) throw new TypeError("Invalid Matter.");
      return workspaceWrite(`/api/messages/${caseId}`, "POST", { text, clientMessageId }, options);
    },
    sendWorkspaceFileMessage: (caseId, file, clientMessageId, options) => {
      if (!validDraftId(caseId) || !validDraftId(file.id) || !Number.isSafeInteger(file.version) || file.version<1) throw new TypeError('Invalid message document.');
      return workspaceWrite(`/api/messages/${caseId}/file`, 'POST', {fileId:file.id,fileVersion:file.version,clientMessageId}, options);
    },
    markWorkspaceMessagesRead: (caseId, upTo, options) => {
      if (!validDraftId(caseId)) throw new TypeError("Invalid Matter.");
      return workspaceWrite(`/api/messages/${caseId}/read`, "POST", { upTo }, options);
    },
    updateWorkspaceMessage: (caseId, messageId, action, changes, reviewedRevision, options) => {
      if (!validDraftId(caseId) || !validDraftId(messageId) || !["edit", "pin", "delete", "react", "unreact"].includes(action)) throw new TypeError("Invalid message action.");
      const method = ["delete", "unreact"].includes(action) ? "DELETE" : action === "react" ? "POST" : "PATCH";
      return workspaceWrite(`/api/messages/${caseId}/${messageId}${["react", "unreact"].includes(action) ? "/react" : ""}`, method, { ...changes, reviewedRevision }, options);
    },
    setWorkspacePresence: async (caseId, active, options) => {
      if (!validDraftId(caseId)) throw new TypeError("Invalid Matter.");
      const key = `${options.ownerId}:${caseId}`;
      if (!presenceLeases.has(key)) presenceLeases.set(key, createWorkspacePresenceLease());
      const result = await workspaceWrite("/api/notifications/workspace-presence", active ? "POST" : "DELETE", { caseId, surface: "messages", ...presenceLeases.get(key).next() }, options);
      if (result?.success !== true) throw new ApiError("invalid_response");
      return result;
    },
    readHiringReview: (caseId, applicantId, options) => {
      if (!validDraftId(caseId) || !validDraftId(applicantId)) throw new TypeError("Invalid hiring review.");
      return paymentRead(`/api/cases/${caseId}/hiring-review/${applicantId}`, options);
    },
    hireReviewedApplicant: (caseId, applicantId, reviewedRevision, options) => {
      if (!validDraftId(caseId) || !validDraftId(applicantId)) throw new TypeError("Invalid hiring selection.");
      return paymentWrite(`/api/cases/${caseId}/hire/${applicantId}`, "POST", { reviewedRevision }, options);
    },
    verifyOwner: verifyDownloadOwner,
    readPendingHire: options => paymentRead("/api/users/me/pending-hire", options),
    savePendingHire: (caseId, paralegalId, reviewedRevision, options) => paymentWrite("/api/users/me/pending-hire", "PUT", { caseId, paralegalId, reviewedRevision }, options),
    clearPendingHire: (reviewedRevision, options) => paymentWrite("/api/users/me/pending-hire", "DELETE", { reviewedRevision }, options),
    readDefaultCard: options => paymentRead("/api/payments/payment-method/default", options),
    async readPaymentSummary(options) {
      try { return await workspaceRead(`/api/payments/summary?expectedOwnerId=${encodeURIComponent(options.ownerId)}`, options); }
      catch (error) { if (error.name === 'AbortError' && !options.signal?.aborted) throw new ApiError('network'); throw error; }
    },
    readPaymentActivity: options => {
      const query = new URLSearchParams({ expectedOwnerId: options.ownerId, limit: String(options.limit || 500) });
      for (const key of ['cursor', 'revision']) if (options[key] != null) query.set(key, options[key]);
      return workspaceRead(`/api/payments/escrow/active?${query}`, options);
    },
    startCardSetup: (requestId, options) => paymentWrite("/api/payments/payment-method/setup-intent", "POST", {}, { ...options, headers: { "Idempotency-Key": requestId } }),
    readCardSetup: (intentId, options) => {
      if (!/^seti_[A-Za-z0-9]{1,200}$/.test(intentId || "")) throw new TypeError("Invalid card setup.");
      return paymentRead(`/api/payments/payment-method/setup-intent/${intentId}`, options);
    },
    setDefaultCard: (paymentMethodId, intentId, options) => paymentWrite("/api/payments/payment-method/default", "POST", { paymentMethodId, intentId }, options),
    readSavedParalegals: (page, options) => workspaceRead(`/api/paralegals/saved?${new URLSearchParams({ page, expectedOwnerId: options.ownerId })}`, options),
    readSavedParalegal: (id, options) => {
      if (!validDraftId(id)) throw new TypeError("Invalid paralegal.");
      return workspaceRead(`/api/paralegals/saved/${id}?expectedOwnerId=${encodeURIComponent(options.ownerId)}`, options);
    },
    saveParalegal: (id, saved, options) => {
      if (!validDraftId(id) || typeof saved !== "boolean") throw new TypeError("Invalid paralegal preference.");
      return workspaceWrite(`/api/paralegals/saved/${id}`, "PUT", { saved }, options);
    },
    get: (path, { signal } = {}) => request(path, { signal }),
    readMatterInventory: (filters, options) => {
      const query = new URLSearchParams({ expectedOwnerId: options.ownerId });
      for (const key of ['view', 'practice', 'deadline', 'updated', 'sort', 'archiveStatus', 'page', 'targetId']) if (filters[key] !== undefined && filters[key] !== '') query.set(key, String(filters[key]));
      if (filters.search) query.set('q', filters.search);
      return workspaceRead(`/api/cases/inventory?${query}`, options);
    },
    async readInvitationOptions(paralegalId, { signal, ownerId, cursor = "" } = {}) {
      if (!validDraftId(paralegalId) || cursor && !validDraftId(cursor)) throw new TypeError("Invalid invitation Matter page.");
      const ticket = generation; await verifyDownloadOwner({ signal, ownerId });
      const value = await request(`/api/cases/invitation-options/${paralegalId}?${new URLSearchParams({ expectedOwnerId: ownerId, ...(cursor ? { cursor } : {}) })}`, { signal });
      await verifyDownloadOwner({ signal, ownerId });
      if (signal?.aborted || ticket !== generation) throw new DOMException("Canceled", "AbortError");
      return value;
    },
    async readInvitationReview(id, paralegalId, { signal, ownerId } = {}) {
      if (!validDraftId(id) || !validDraftId(paralegalId)) throw new TypeError("Invalid invitation review.");
      const ticket = generation; await verifyDownloadOwner({ signal, ownerId });
      const value = await request(`/api/cases/${id}/invitation-review/${paralegalId}?expectedOwnerId=${encodeURIComponent(ownerId)}`, { signal });
      await verifyDownloadOwner({ signal, ownerId });
      if (signal?.aborted || ticket !== generation) throw new DOMException("Canceled", "AbortError");
      return value;
    },
    async sendReviewedInvitation(id, paralegalId, reviewedRevision, { signal, ownerId } = {}) {
      if (!validDraftId(id) || !validDraftId(paralegalId) || !/^[a-f0-9]{64}$/.test(reviewedRevision || "")) throw new TypeError("Invalid invitation confirmation.");
      const ticket = generation;
      const value = await privateWrite(`/api/cases/${id}/invite/${paralegalId}`, "POST", { reviewedRevision, expectedOwnerId: ownerId }, { signal, ownerId });
      await verifyDownloadOwner({ signal, ownerId });
      if (signal?.aborted || ticket !== generation) throw new DOMException("Canceled", "AbortError");
      return value;
    },
    async readPreEngagement(id, applicantId, { signal, ownerId } = {}) {
      if (!validDraftId(id) || !validDraftId(applicantId)) throw new TypeError("Invalid pre-engagement review.");
      const ticket = generation; await verifyDownloadOwner({ signal, ownerId });
      const value = await request(`/api/cases/${id}/pre-engagement/review/${applicantId}?expectedOwnerId=${encodeURIComponent(ownerId)}`, { signal });
      await verifyDownloadOwner({ signal, ownerId });
      if (signal?.aborted || ticket !== generation) throw new DOMException("Canceled", "AbortError");
      return value;
    },
    async requestPreEngagement(id, applicantId, input, { signal, ownerId } = {}) {
      if (!validDraftId(id) || !validDraftId(applicantId)) throw new TypeError("Invalid pre-engagement request.");
      const ticket = generation; await verifyDownloadOwner({ signal, ownerId });
      const csrf = await request("/api/csrf", { signal });
      if (typeof csrf.csrfToken !== "string" || !csrf.csrfToken) throw new ApiError("invalid_response");
      if (signal?.aborted || ticket !== generation) throw new DOMException("Canceled", "AbortError");
      const body = new FormData();
      for (const key of ["reviewedRevision", "confidentialityAgreementRequired", "conflictsCheckRequired", "conflictsDetails"]) body.set(key, String(input[key] ?? ""));
      body.set("expectedOwnerId", ownerId);
      if (input.file) body.set("confidentialityFile", input.file, input.file.name);
      const value = await request(`/api/cases/${id}/pre-engagement/${applicantId}/request`, { signal, method: "POST", body, headers: { "X-CSRF-Token": csrf.csrfToken } });
      await verifyDownloadOwner({ signal, ownerId });
      if (signal?.aborted || ticket !== generation) throw new DOMException("Canceled", "AbortError");
      return value;
    },
    async reviewPreEngagement(id, applicantId, input, { signal, ownerId } = {}) {
      if (!validDraftId(id) || !validDraftId(applicantId)) throw new TypeError("Invalid pre-engagement response.");
      const ticket = generation;
      const value = await privateWrite(`/api/cases/${id}/pre-engagement/review`, "POST", { ...input, applicantId, expectedOwnerId: ownerId }, { signal, ownerId });
      await verifyDownloadOwner({ signal, ownerId });
      if (signal?.aborted || ticket !== generation) throw new DOMException("Canceled", "AbortError");
      return value;
    },
    async openPreEngagementDocument(id, applicantId, revision, key, { signal, ownerId } = {}) {
      const ticket = generation;
      const check = async () => {
        const review = await this.readPreEngagement(id, applicantId, { signal, ownerId });
        if (review.revision !== revision || !review.selectedRequest || !review.request?.documents?.some(doc => doc.key === key)) throw new ApiError("request", 409, "PRE_ENGAGEMENT_CHANGED");
      };
      await check();
      const value = await request(`/api/uploads/signed-get?${new URLSearchParams({ caseId: id, key })}`, { signal });
      await check();
      if (signal?.aborted || ticket !== generation) throw new DOMException("Canceled", "AbortError");
      return value;
    },
    async readMatterExport(id, { signal, ownerId } = {}) {
      if (!validDraftId(id)) throw new TypeError("Invalid Matter.");
      const ticket = generation; await verifyDownloadOwner({ signal, ownerId });
      if (ticket !== generation || signal?.aborted) throw new DOMException("Canceled", "AbortError");
      return request(`/api/cases/${id}/archive/export?expectedOwnerId=${encodeURIComponent(ownerId)}`, { signal });
    },
    async downloadMatterExport(id, revision, { signal, ownerId } = {}) {
      if (!validDraftId(id) || !/^[a-f0-9]{64}$/.test(revision || "")) throw new TypeError("Invalid archive review.");
      const ticket = generation; await verifyDownloadOwner({ signal, ownerId });
      if (ticket !== generation || signal?.aborted) throw new DOMException("Canceled", "AbortError");
      const blob = await request(`/api/cases/${id}/archive/download?expectedOwnerId=${encodeURIComponent(ownerId)}&revision=${revision}`, { signal, binary: "application/zip", headers: { Accept: "application/zip" } });
      if (ticket !== generation || signal?.aborted) throw new DOMException("Canceled", "AbortError");
      await verifyDownloadOwner({ signal, ownerId });
      if (ticket !== generation || signal?.aborted) throw new DOMException("Canceled", "AbortError");
      return blob;
    },
    async readReceiptHistory(id, options = {}) {
      if (!validDraftId(id)) throw new TypeError("Invalid Matter.");
      const query = new URLSearchParams({ expectedOwnerId: options.ownerId });
      for (const key of ["cursor", "revision", "receiptId"]) if (options[key] !== undefined && options[key] !== null) query.set(key, options[key]);
      return workspaceRead(`/api/payments/receipt/attorney/${id}/history?${query}`, options);
    },
    async readMatterReceipt(id, { signal, ownerId, receiptId } = {}) {
      if (!validDraftId(id) || receiptId !== undefined && receiptId !== "payment" && !/^[a-f0-9]{64}$/.test(receiptId)) throw new TypeError("Invalid Matter receipt.");
      const ticket = generation;
      await verifyDownloadOwner({ signal, ownerId });
      if (ticket !== generation || signal?.aborted) throw new DOMException("Canceled", "AbortError");
      const value = await request(`/api/payments/receipt/attorney/${id}/review?expectedOwnerId=${encodeURIComponent(ownerId)}${receiptId ? `&receiptId=${encodeURIComponent(receiptId)}` : ""}`, { signal });
      await verifyDownloadOwner({ signal, ownerId });
      if (ticket !== generation || signal?.aborted) throw new DOMException("Canceled", "AbortError");
      return value;
    },
    async downloadMatterReceipt(id, revision, { signal, ownerId, receiptId } = {}) {
      if (!validDraftId(id) || !/^[a-f0-9]{64}$/.test(revision || "") || receiptId !== undefined && receiptId !== "payment" && !/^[a-f0-9]{64}$/.test(receiptId)) throw new TypeError("Invalid receipt review.");
      const ticket = generation;
      await verifyDownloadOwner({ signal, ownerId });
      if (ticket !== generation || signal?.aborted) throw new DOMException("Canceled", "AbortError");
      const blob = await request(`/api/payments/receipt/attorney/${id}?expectedOwnerId=${encodeURIComponent(ownerId)}&revision=${revision}${receiptId ? `&receiptId=${encodeURIComponent(receiptId)}` : ""}`, { signal, binary: "application/pdf", headers: { Accept: "application/pdf" } });
      if (ticket !== generation || signal?.aborted) throw new DOMException("Canceled", "AbortError");
      await verifyDownloadOwner({ signal, ownerId });
      if (ticket !== generation || signal?.aborted) throw new DOMException("Canceled", "AbortError");
      return blob;
    },
    async readMatterDownloads(id, { signal, ownerId, cursor } = {}) {
      const ticket = generation;
      const path = `${draftPath(id).replace("/case-drafts/", "/cases/")}/downloads`;
      if (cursor && !validDraftId(cursor)) throw new TypeError("Invalid file page.");
      await verifyDownloadOwner({ signal, ownerId });
      if (ticket !== generation || signal?.aborted) throw new DOMException("Canceled", "AbortError");
      return request(`${path}?expectedOwnerId=${encodeURIComponent(ownerId)}${cursor ? `&cursor=${cursor}` : ""}`, { signal });
    },
    async downloadMatterFile(id, fileId, revision, { signal, ownerId } = {}) {
      const ticket = generation;
      const path = `${draftPath(id).replace("/case-drafts/", "/cases/")}/downloads`;
      if (!validDraftId(fileId) || !/^[a-f0-9]{64}$/.test(revision || "")) throw new TypeError("Invalid file review.");
      await verifyDownloadOwner({ signal, ownerId });
      if (ticket !== generation || signal?.aborted) throw new DOMException("Canceled", "AbortError");
      const blob = await request(`${path}/${fileId}?expectedOwnerId=${encodeURIComponent(ownerId)}&revision=${revision}`, { signal, binary: true, headers: { Accept: "application/octet-stream" } });
      if (ticket !== generation || signal?.aborted) throw new DOMException("Canceled", "AbortError");
      await verifyDownloadOwner({ signal, ownerId });
      if (ticket !== generation || signal?.aborted) throw new DOMException("Canceled", "AbortError");
      return blob;
    },
    async prepareMatterPdfPreview(id, fileId, revision, options = {}) {
      if (!validDraftId(id) || !validDraftId(fileId) || !/^[a-f0-9]{64}$/.test(revision || "")) throw new TypeError("Invalid document preview.");
      await verifyDownloadOwner(options);
      return `/api/cases/${id}/downloads/${fileId}?${new URLSearchParams({ expectedOwnerId: options.ownerId, revision, preview: "true" })}`;
    },
    async readMatterArchive(id, { signal, ownerId } = {}) {
      const path = `${draftPath(id).replace("/case-drafts/", "/cases/")}/archive`;
      const ticket = generation;
      const session = classifySession(await request("/api/auth/me", { signal }));
      if (session.state !== "ready" || session.identity.id !== ownerId) { onAuthenticationLost?.(); throw new ApiError("authentication"); }
      if (signal?.aborted || ticket !== generation) throw new DOMException("Canceled", "AbortError");
      return request(`${path}?expectedOwnerId=${encodeURIComponent(ownerId)}`, { signal });
    },
    changeMatterArchive: (id, review, options) => privateWrite(`${draftPath(id).replace("/case-drafts/", "/cases/")}/archive`, "PATCH", { ...review, expectedOwnerId: options?.ownerId }, options),
    async readApplicationDecision(id, applicantId, { signal, ownerId } = {}) {
      if (!validDraftId(id) || !validDraftId(applicantId)) throw new TypeError("Invalid application.");
      const ticket = generation; await verifyDownloadOwner({ signal, ownerId });
      const value = await request(`/api/cases/${id}/application-review/${applicantId}/decision?expectedOwnerId=${encodeURIComponent(ownerId)}`, { signal });
      await verifyDownloadOwner({ signal, ownerId });
      if (signal?.aborted || ticket !== generation) throw new DOMException("Canceled", "AbortError");
      return value;
    },
    async readApplicationDecisionResult(id, applicantId, requestId, { signal, ownerId } = {}) {
      if (!validDraftId(id) || !validDraftId(applicantId) || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(requestId || "")) throw new TypeError("Invalid application decision.");
      const ticket = generation; await verifyDownloadOwner({ signal, ownerId });
      const value = await request(`/api/cases/${id}/application-review/${applicantId}/decision/${requestId}?expectedOwnerId=${encodeURIComponent(ownerId)}`, { signal });
      await verifyDownloadOwner({ signal, ownerId });
      if (signal?.aborted || ticket !== generation) throw new DOMException("Canceled", "AbortError");
      return value;
    },
    async saveApplicationDecision(id, applicantId, input, { signal, ownerId } = {}) {
      if (!validDraftId(id) || !validDraftId(applicantId)) throw new TypeError("Invalid application.");
      const ticket = generation;
      const value = await privateWrite(`/api/cases/${id}/application-review/${applicantId}/decision`, "POST", { ...input, expectedOwnerId: ownerId }, { signal, ownerId });
      await verifyDownloadOwner({ signal, ownerId });
      if (signal?.aborted || ticket !== generation) throw new DOMException("Canceled", "AbortError");
      return value;
    },
    async readApplicationResume(id, applicantId, { signal, ownerId } = {}) {
      if (!validDraftId(id) || !validDraftId(applicantId)) throw new TypeError("Invalid application.");
      const ticket = generation; await verifyDownloadOwner({ signal, ownerId });
      if (signal?.aborted || ticket !== generation) throw new DOMException("Canceled", "AbortError");
      const value = await request(`/api/cases/${id}/application-review/${applicantId}/resume?expectedOwnerId=${encodeURIComponent(ownerId)}`, { signal });
      await verifyDownloadOwner({ signal, ownerId });
      if (signal?.aborted || ticket !== generation) throw new DOMException("Canceled", "AbortError");
      return value;
    },
    async downloadApplicationResume(id, applicantId, revision, { signal, ownerId } = {}) {
      if (!validDraftId(id) || !validDraftId(applicantId) || typeof revision !== "string" || !/^[a-f0-9]{64}$/.test(revision)) throw new TypeError("Invalid résumé review.");
      const ticket = generation; await verifyDownloadOwner({ signal, ownerId });
      if (signal?.aborted || ticket !== generation) throw new DOMException("Canceled", "AbortError");
      const blob = await request(`/api/cases/${id}/application-review/${applicantId}/resume/download?expectedOwnerId=${encodeURIComponent(ownerId)}&revision=${revision}`, { signal, binary: "application/pdf", headers: { Accept: "application/pdf" } });
      if (blob.size > 10 * 1024 * 1024) throw new ApiError("invalid_response");
      await verifyDownloadOwner({ signal, ownerId });
      if (signal?.aborted || ticket !== generation) throw new DOMException("Canceled", "AbortError");
      return blob;
    },
    readContextualBlock: (blockedId, options) => {
      if (!validDraftId(blockedId)) throw new TypeError("Invalid block target.");
      return workspaceRead(`/api/blocks/${blockedId}?expectedOwnerId=${encodeURIComponent(options.ownerId)}`, options);
    },
    createContextualBlock: (caseId, blockedId, { application = false, ...options } = {}) => {
      if (!validDraftId(caseId) || !validDraftId(blockedId) || typeof application !== "boolean") throw new TypeError("Invalid block context.");
      return workspaceWrite("/api/blocks", "POST", { caseId, expectedBlockedId: blockedId, ...(application ? { paralegalId: blockedId } : {}) }, options);
    },
    readApplicationInventory: (id, filters, options) => {
      if (!validDraftId(id)) throw new TypeError("Invalid Matter.");
      const query = new URLSearchParams({ expectedOwnerId: options.ownerId, page: String(filters.page), sort: filters.sort, status: filters.status });
      if (filters.search) query.set("q", filters.search);
      if (filters.applicantId) query.set("applicantId", filters.applicantId);
      return workspaceRead(`/api/cases/${id}/application-inventory?${query}`, options);
    },
    async readMatterApplications(id, { signal, ownerId, cursor = "", applicantId = "" } = {}) {
      const path = `${draftPath(id).replace("/case-drafts/", "/cases/")}/application-review`;
      const ticket = generation;
      if (!/^(?:a:[a-f0-9]{24}|m:(?:0|[1-9]\d{0,3}))?$/i.test(cursor) || (applicantId && !validDraftId(applicantId)) || (cursor && applicantId)) throw new TypeError("Invalid application page.");
      await verifyDownloadOwner({ signal, ownerId });
      if (signal?.aborted || ticket !== generation) throw new DOMException("Canceled", "AbortError");
      const query = new URLSearchParams({ expectedOwnerId: ownerId, ...(cursor ? { cursor } : {}), ...(applicantId ? { applicantId } : {}) });
      const value = await request(`${path}?${query}`, { signal });
      await verifyDownloadOwner({ signal, ownerId });
      if (signal?.aborted || ticket !== generation) throw new DOMException("Canceled", "AbortError");
      return value;
    },
    readMatterInvitations: (id, options = {}) => {
      const path = `${draftPath(id).replace("/case-drafts/", "/cases/")}/invites`;
      return workspaceRead(`${path}?expectedOwnerId=${encodeURIComponent(options.ownerId)}`, options);
    },
    async readMatterViews({ signal, ownerId } = {}) {
      const ticket = generation;
      const session = classifySession(await request("/api/auth/me", { signal }));
      if (session.state !== "ready" || session.identity.id !== ownerId) { onAuthenticationLost?.(); throw new ApiError("authentication"); }
      if (signal?.aborted || ticket !== generation) throw new DOMException("Canceled", "AbortError");
      return request(`/api/account/dashboard-views?scope=attorney_matters&expectedOwnerId=${encodeURIComponent(ownerId)}`, { signal });
    },
    saveMatterView: (review, options) => privateWrite("/api/account/dashboard-views", "POST", { ...review, expectedOwnerId: options?.ownerId }, options),
    deleteMatterView: (id, revision, options) => {
      if (!/^[\w-]{1,80}$/.test(id || "")) throw new TypeError("Invalid saved view ID.");
      return privateWrite(`/api/account/dashboard-views/attorney_matters/${id}`, "DELETE", { revision, expectedOwnerId: options?.ownerId }, options);
    },
    publishMatter: (review, options) => privateWrite("/api/cases/posting/publications", "POST", { ...review, expectedOwnerId: options?.ownerId }, options),
    cleanupMatterPublication: (requestId, options) => {
      if (!/^[a-f0-9-]{36}$/i.test(requestId || "")) throw new TypeError("Invalid publication request.");
      return privateWrite(`/api/cases/posting/publications/${requestId}/cleanup`, "POST", { expectedOwnerId: options?.ownerId }, options);
    },
    saveMatterPosting: (id, changes, revision, options) => privateWrite(draftPath(id).replace("/case-drafts/", "/cases/posting/"), "PATCH", { changes, revision, expectedOwnerId: options?.ownerId }, options),
    deleteMatterPosting: (id, revision, options) => privateWrite(draftPath(id).replace("/case-drafts/", "/cases/posting/"), "DELETE", { revision, expectedOwnerId: options?.ownerId }, options),
    requestMatterReview: (id, review, options) => privateWrite(`${draftPath(id).replace("/case-drafts/", "/cases/")}/flags/mark-resolved`, "POST", { ...review, expectedOwnerId: options?.ownerId }, options),
    saveMatterNote: (id, note, revision, options) => privateWrite(`${draftPath(id).replace("/case-drafts/", "/cases/")}/notes`, "PUT", { note, revision, expectedOwnerId: options?.ownerId }, options),
    createMatterDraft: (fields, clientRequestId, options) => privateWrite("/api/case-drafts", "POST", { ...draftValues(fields), clientRequestId, expectedOwnerId: options?.ownerId }, options),
    saveMatterDraft: (id, fields, revision, options) => privateWrite(draftPath(id), "PUT", { ...draftValues(fields), revision, expectedOwnerId: options?.ownerId }, options),
    deleteMatterDraft: (id, revision, options) => privateWrite(draftPath(id), "DELETE", { revision, expectedOwnerId: options?.ownerId }, options),
    createPrivateTask: ({ title, notes, due, caseId }, options) => privateWrite("/api/checklist", "POST", { title, notes, due, caseId }, options),
    togglePrivateTask: (id, options) => privateWrite(`${taskPath(id)}/toggle`, "POST", {}, options),
    deletePrivateTask: (id, options) => privateWrite(taskPath(id), "DELETE", {}, options),
    saveWeeklyNotes: ({ weekStart, notes, revision }, options) => privateWrite("/api/users/me/weekly-notes", "PUT", { weekStart, notes, revision }, options),
    async completeAttorneyTour({ signal } = {}) {
      const ticket = generation;
      const csrf = await request("/api/csrf", { signal });
      if (signal?.aborted || ticket !== generation) throw new DOMException("Canceled", "AbortError");
      if (typeof csrf.csrfToken !== "string" || !csrf.csrfToken) throw new ApiError("invalid_response");
      const result = await request("/api/users/me/onboarding", {
        signal, method: "PATCH", headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf.csrfToken },
        body: JSON.stringify({ attorneyTourCompleted: true }),
      });
      if (result.onboarding?.attorneyTourCompleted !== true) throw new ApiError("invalid_response");
      return true;
    },
    clear() {
      generation += 1;
      pending.forEach((controller) => controller.abort());
      pending.clear();
    },
  });
}
