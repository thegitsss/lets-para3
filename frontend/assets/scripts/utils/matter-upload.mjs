export const MAX_MATTER_FILE_BYTES = 500 * 1024 * 1024;
export const BUFFERED_MATTER_FILE_BYTES = 20 * 1024 * 1024;
const PART_BYTES = 8 * 1024 * 1024;
const types = { pdf: "application/pdf", doc: "application/msword", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", xls: "application/vnd.ms-excel", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", ppt: "application/vnd.ms-powerpoint", pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation", txt: "text/plain", csv: "text/csv", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif" };
const canceled = () => new DOMException("The upload was canceled.", "AbortError");
const checksum = async part => [...new Uint8Array(await crypto.subtle.digest("SHA-256", await part.arrayBuffer()))].map(value => value.toString(16).padStart(2, "0")).join("");
const pause = (signal, delay) => new Promise((resolve, reject) => {
  if (signal?.aborted) { reject(canceled()); return; }
  const abort = () => { clearTimeout(timer); reject(canceled()); };
  const timer = setTimeout(() => { signal?.removeEventListener("abort", abort); resolve(); }, delay);
  signal?.addEventListener("abort", abort, { once: true });
});
async function waitForConnection(signal) {
  if (typeof navigator === "undefined" || navigator.onLine !== false) return;
  await new Promise((resolve, reject) => {
    const cleanup = () => { globalThis.removeEventListener("online", online); signal?.removeEventListener("abort", abort); };
    const online = () => { cleanup(); resolve(); }, abort = () => { cleanup(); reject(canceled()); };
    globalThis.addEventListener("online", online, { once: true }); signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort(); else if (navigator.onLine !== false) online();
  });
}
async function retry(operation, signal, waiting) {
  for (let attempt = 0; ; attempt++) {
    if (signal?.aborted) throw canceled();
    if (typeof navigator !== "undefined" && navigator.onLine === false) { waiting?.(true); await waitForConnection(signal); waiting?.(false); attempt = 0; }
    try { return await operation(); }
    catch (error) {
      if (signal?.aborted || error.name === "AbortError") throw canceled();
      if ((error.code || error.payload?.code) === "FILE_TRANSFER_STORAGE_PROOF_UNAVAILABLE") throw error;
      if (typeof navigator !== "undefined" && navigator.onLine === false) continue;
      if (attempt >= 6 || error.status && ![408, 429, 500, 502, 503, 504].includes(error.status)) throw error;
      await pause(signal, Math.max(error.retryAfterMs || 0, Math.min(10000, 300 * 2 ** attempt)));
    }
  }
}
// Retrying reuses the recorded transfer and skips acknowledged parts. The
// selected Blob stays in the browser, with one bounded part in flight.
export async function transferMatterFile({ file, caseId, ownerId, requestId, targetFileId, request, signal, onProgress }) {
  const base = `/api/uploads/case/${encodeURIComponent(caseId)}/transfers`;
  const options = { signal, headers: { "X-LPC-Owner-Id": ownerId } };
  let percent = 0;
  const progress = value => { percent = value; onProgress?.(value); };
  const run = operation => retry(operation, signal, waiting => onProgress?.(percent, { phase: waiting ? "waiting" : "uploading" }));
  const checked = value => {
    if (!value || !/^[a-f0-9]{24}$/.test(value.id) || value.caseId !== caseId || value.ownerId !== ownerId || value.requestId !== requestId || value.size !== file.size || value.partBytes !== PART_BYTES || !Number.isSafeInteger(value.receivedBytes) || value.receivedBytes < 0 || value.receivedBytes > file.size || !Number.isSafeInteger(value.nextPart) || value.nextPart !== Math.ceil(value.receivedBytes / PART_BYTES) + 1 || !["uploading", "completing", "verifying", "uploaded"].includes(value.status) || !["relay", "direct"].includes(value.transport) || !Array.isArray(value.parts) || value.parts.length !== value.nextPart - 1 || value.parts.some((part, index) => part.number !== index + 1 || part.size !== Math.min(PART_BYTES, file.size - index * PART_BYTES) || !/^[a-f0-9]{64}$/.test(part.sha256))) throw new Error("The upload receipt could not be verified.");
    return value;
  };
  const json = (path, body) => request(path, { ...options, method: "POST", headers: { ...options.headers, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  let transfer = checked(await run(() => json(base, { expectedOwnerId: ownerId, requestId, name: file.name, size: file.size, mimeType: types[file.name.split(".").at(-1).toLowerCase()] || file.type, ...(targetFileId ? { targetFileId } : {}) })));
  // Re-selecting another file with the same name and size must not combine
  // yesterday's acknowledged bytes with a different original.
  for (const part of transfer.parts) {
    if (await checksum(file.slice((part.number - 1) * PART_BYTES, part.number * PART_BYTES)) !== part.sha256) throw new Error("This document changed. Select the original file to resume, or start a new upload.");
  }
  let useDirect = transfer.transport === "direct";
  while (transfer.status === "uploading" && transfer.receivedBytes < file.size) {
    const offset = transfer.receivedBytes, part = file.slice(offset, Math.min(offset + PART_BYTES, file.size));
    const path = `${base}/${transfer.id}/parts/${transfer.nextPart}`;
    // LPC checks the first bounded section's real file signature. This lets
    // the remaining original go direct without waiting for the background
    // malware scan merely to record the upload as pending security review.
    if (useDirect && transfer.nextPart > 1) {
      const sha256 = await checksum(part), signed = await run(() => json(`${path}/presign`, { sha256 }));
      if (signed.acknowledged) transfer = checked(signed);
      else {
        if (signed.transferId !== transfer.id || signed.partNumber !== transfer.nextPart || signed.size !== part.size || signed.sha256 !== sha256 || typeof signed.url !== "string" || signed.headers?.["x-amz-checksum-sha256"] !== btoa(String.fromCharCode(...new Uint8Array(sha256.match(/../g).map(value => parseInt(value, 16)))))) throw new Error("The upload instructions could not be verified.");
        try {
          const response = await fetch(signed.url, { method: "PUT", credentials: "omit", redirect: "error", headers: signed.headers, body: part, signal });
          if (!response.ok) throw new Error("Document storage did not acknowledge this part.");
        } catch (error) {
          if (signal?.aborted || error.name === "AbortError") throw canceled();
          // A blocked storage endpoint or network path falls back in place.
          // The same checksum and transfer identity still protect the bytes.
          useDirect = false;
        }
        if (useDirect) {
          try { transfer = checked(await run(() => json(`${path}/acknowledge`, { sha256 }))); }
          catch (error) { if ((error.code || error.payload?.code) !== "FILE_TRANSFER_STORAGE_PROOF_UNAVAILABLE") throw error; useDirect = false; }
        }
      }
    }
    if (!useDirect || transfer.nextPart === 1) transfer = checked(await run(() => request(path, { ...options, method: "PUT", headers: { ...options.headers, "Content-Type": "application/octet-stream" }, body: part })));
    useDirect = useDirect && transfer.transport === "direct";
    progress(Math.min(99, Math.round(transfer.receivedBytes / file.size * 100)));
  }
  let checks = 0;
  while (transfer.status !== "uploaded") {
    if (checks++) await pause(signal, Math.min(5000, checks * 1000));
    transfer = checked(await run(() => json(`${base}/${transfer.id}/complete`, { expectedOwnerId: ownerId })));
    progress(99);
  }
  if (transfer.status !== "uploaded" || transfer.receivedBytes !== file.size) throw new Error("The uploaded document could not be confirmed.");
  return transfer.id;
}
export async function uploadMatterForm(api, path, form, options, ownerId) {
  const file = form.get("file");
  if (!file || file.size <= BUFFERED_MATTER_FILE_BYTES) return api.upload(path, form, options);
  const caseId = String(form.get("caseId") || ""), requestId = String(form.get("clientUploadId") || "");
  const transferId = await transferMatterFile({ file, caseId, ownerId, requestId, signal: options.signal, onProgress: options.onProgress, request: (url, input) => api.request(url, input) });
  const body = Object.fromEntries([...form.entries()].filter(([name]) => name !== "file"));
  const result = await api.post(path, { ...body, expectedOwnerId: ownerId, transferId }, { signal: options.signal, headers: { "X-LPC-Owner-Id": ownerId } });
  options.onProgress?.(100);
  return result;
}
