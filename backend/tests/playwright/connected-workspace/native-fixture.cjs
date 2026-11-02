"use strict";
// Actual checked-in role shells and modules. Only network DTOs/providers are
// controlled here; this fixture never replaces HTML or injects a component.
const { buildMatterExperience } = require("../../../services/matterExperience");
const OWNER = "0123456789abcdef01234567", PARA = "1123456789abcdef01234567", MATTER = "2123456789abcdef01234567", FILE = "3123456789abcdef01234567", PLAN = "4123456789abcdef01234567", JOB = "5123456789abcdef01234567", DRAFT = "6123456789abcdef01234567";
const revision = "a".repeat(64);
const MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
function user(role = "attorney") {
  const id = role === "attorney" ? OWNER : PARA;
  return { id, _id: id, role, status: "approved", firstName: role === "attorney" ? "Maya" : "Morgan", lastName: role === "attorney" ? "Bennett" : "Ellis", email: role + "@native-connected.test", isFirstLogin: false, bio: "Discovery and litigation document preparation.", about: "Discovery and litigation document preparation.", skills: ["Clio", "Discovery"], practiceAreas: ["Litigation"], specialties: ["Litigation"], yearsExperience: 6, state: "Virginia", location: "Virginia", lawFirm: "Bennett Legal", barNumber: "SYNTHETIC-123", availability: "Available now", resumeURL: "/synthetic-resume.pdf", preferences: { theme: "light", fontSize: "md" }, onboarding: { attorneyTourCompleted: true, paralegalTourCompleted: true, paralegalProfileTourCompleted: true }, profilePhotoStatus: "approved", profileImage: "", avatarURL: "" };
}
function matter(role = "attorney", patch = {}) {
  const raw = { _id: MATTER, id: MATTER, title: "River Street discovery review", details: "Prepare discovery responses and a chronology for attorney review.", status: "in progress", attorney: { _id: OWNER, id: OWNER, firstName: "Maya", lastName: "Bennett" }, attorneyId: OWNER, paralegal: { _id: PARA, id: PARA, firstName: "Morgan", lastName: "Ellis" }, paralegalId: PARA, tasks: [{ title: "Prepare discovery responses", completed: false }, { title: "Prepare chronology", completed: false }], practiceArea: "litigation", state: "Virginia", totalAmount: 80000, escrowStatus: "funded", escrowIntentId: "pi_synthetic_native_workspace", paymentReleased: false, archived: false, readOnly: false, hiredAt: "2026-10-01T12:00:00.000Z", deadlineDate: "2026-12-10", files: [], applicants: [], ...patch };
  raw.matterExperience = buildMatterExperience(raw, { viewer: { id: role === "attorney" ? OWNER : PARA, role }, acl: { isAttorney: role === "attorney", isParalegal: role === "paralegal" } });
  return JSON.parse(JSON.stringify(raw));
}
function preparation(patch = {}) {
  return { id: PLAN, kind: "preparation", status: "proposed", revision: 0, stale: false, items: [{ title: "Prepare discovery responses", citations: [{ sourceId: "scope", quote: "Prepare discovery responses", name: "Agreed Matter instructions", fileId: null, page: null, section: null }] }], questions: [], observations: [], files: [{ id: FILE, name: "Discovery instructions.docx", version: 1, unreadablePages: [] }], coverageNotice: "Only the agreed instructions and selected readable text were reviewed.", ...patch };
}
function prepSnapshot(role = "attorney", patch = {}) {
  return { caseId: MATTER, title: "River Street discovery review", role, aiConfigured: true, files: [{ id: FILE, name: "Discovery instructions.docx", mimeType: MIME, size: 2400, version: 1, securityStatus: "clean", status: "pending_review", revision }], preparation: preparation(), submission: null, activeJob: null, ...patch };
}
function workReview() {
  return { caseId: MATTER, title: "River Street discovery review", ownerId: OWNER, revision, taskRevision: 0, items: [{ index: 0, id: null, title: "Prepare discovery responses", completed: false, canToggle: true }, { index: 1, id: null, title: "Prepare chronology", completed: false, canToggle: true }], canToggle: true, canEditScope: false, completedLocked: false, reason: "ready" };
}
function filesReview(ownerId = OWNER, patch = {}) {
  const file = { id: FILE, name: "Discovery instructions.docx", version: 1, revision, reviewRevision: revision, size: 2400, uploadedAt: "2026-10-02T12:00:00.000Z", securityStatus: "clean", status: "pending_review", uploadedByRole: "paralegal", notes: "", mimeType: MIME, canReview: true, requestedAt: null, approvedAt: null, replacedAt: null, revisionOf: null };
  return { caseId: MATTER, ownerId, caseTitle: "River Street discovery review", access: "available", canUpload: true, selection: "none", selectedFile: null, files: [file], total: 1, nextCursor: null, legacyAttachments: false, filters: { q: "", status: "all", sort: "newest" }, counts: { total: 1, awaitingReview: 1, revisions: 0, approved: 0 }, ...patch };
}
async function installNativeFixture(page, { role = "attorney", resolve, userPatch = {}, matterPatch = {}, editorScript = false, origin = "http://127.0.0.1:19077" } = {}) {
  const state = { user: { ...user(role), ...userPatch }, matter: matter(role, matterPatch), calls: [], unknown: [], pageErrors: [], resolve };
  page.on("pageerror", error => state.pageErrors.push(error.message));
  await page.route("**/*", async route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname;
    if (url.origin === "https://editor.synthetic.test" && path === "/web-apps/apps/api/documents/api.js" && editorScript) {
      await route.fulfill({ contentType: "text/javascript", body: "window.DocsAPI={DocEditor:class{constructor(id,config){window.nativeEditorFixture={config,destroyed:false};document.getElementById(id).textContent='Synthetic editor provider fixture';this.config=config;config.events.onDocumentReady?.();}destroyEditor(){window.nativeEditorFixture.destroyed=true;}requestClose(){this.config.events.onRequestClose?.();}}};" }); return;
    }
    if (url.origin !== origin) { await route.abort("blockedbyclient"); return; }
    if (!path.startsWith("/api/")) { await route.continue(); return; }
    let body = null; try { body = request.postDataJSON(); } catch { /* No POST body. */ }
    const call = { method: request.method(), path, query: Object.fromEntries(url.searchParams), body };
    state.calls.push(call);
    const send = value => route.fulfill({ status: value.statusCode || 200, json: value.body || value });
    if (state.resolve) { const response = await state.resolve(call, state); if (response) { await send(response); return; } }
    if (path.endsWith("/stream") || path.endsWith("/events")) { await route.fulfill({ status: 200, contentType: "text/event-stream", body: ": synthetic controlled transport\n\n" }); return; }
    if (path === "/api/auth/me") { await send({ user: state.user }); return; }
    if (path === "/api/auth/workspace-release") { await send({ workspace: { schemaVersion: 1, ownerId: state.user.id, role, revision: 1, version: "v2", defaultDestination: "/" + role + "-v2.html#/home" } }); return; }
    if (path === "/api/csrf") { await send({ csrfToken: "synthetic-native-token" }); return; }
    if (path === "/api/matter-preparation/matters/" + MATTER) { await send(prepSnapshot(role, { aiConfigured: false, preparation: null })); return; }
    if (path === "/api/document-collaboration/status") { await send({ configured: false }); return; }
    if (path === "/api/integrations/clio/status") { await send({ configured: false, connected: false, ownerId: state.user.id, needsReconnect: false }); return; }
    if (path === "/api/users/me") { await send(state.user); return; }
    if (path === "/api/account/preferences") { await send({ ...state.user.preferences, ownerId: state.user.id }); return; }
    if (path === "/api/users/me/onboarding") { await send({ onboarding: state.user.onboarding }); return; }
    if (path === "/api/cases/" + MATTER) { await send(state.matter); return; }
    if (path === "/api/cases/" + MATTER + "/work-review") { await send(workReview()); return; }
    if (path === "/api/cases/" + MATTER + "/completion-review") { await send({ caseId: MATTER, ownerId: state.user.id, caseTitle: state.matter.title, paralegalId: PARA, paralegalName: "Morgan Ellis", retentionMonths: 12, revision, canComplete: false, blockers: ["incomplete_scope_tasks"], mode: "complete_and_release", payoutState: "none", grossCents: 80000, feeCents: 8000, payoutCents: 72000, currency: "USD", work: { total: 2, complete: 0 }, documents: { total: 1, awaitingReview: 1, revisions: 0, approved: 0, securityPending: 0 }, completedAt: null, archiveReady: false, purgeAt: null, operation: null }); return; }
    if (path === "/api/cases/" + MATTER + "/work-summary") { await send({ caseId: MATTER, ownerId: OWNER, items: [], revision }); return; }
    if (path === "/api/cases/" + MATTER + "/files/review") {
      const value = filesReview(state.user.id), selected = value.files.find(file => file.id === call.query.fileId);
      value.filters = { q: call.query.q || "", status: call.query.status || "all", sort: call.query.sort || "newest" };
      if (selected) { value.selection = "found"; value.selectedFile = selected; }
      await send(value); return;
    }
    if (path === "/api/uploads/case/" + MATTER + "/upload-review") { await send({ caseId: MATTER, ownerId: state.user.id, canUpload: true, revision, upload: null }); return; }
    if (path === "/api/integrations/clio/transfers") { await send({ items: [] }); return; }
    if (path === "/api/uploads/case/" + MATTER) { await send({ caseId: MATTER, files: [{ _id: FILE, id: FILE, originalName: "Discovery instructions.docx", filename: "Discovery instructions.docx", mimeType: MIME, size: 2400, version: 1, status: "pending_review", securityStatus: "clean", uploadedByRole: "paralegal", userId: PARA, createdAt: "2026-10-02T12:00:00.000Z" }], writable: true }); return; }
    if (path === "/api/public/paralegals") { await send({ items: [], total: 0, page: 1, pages: 0, hasMore: false }); return; }
    if (path === "/api/paralegals/" + PARA) { await send({ statusCode: 404, body: { error: "Synthetic public profile only" } }); return; }
    if (path === "/api/public/paralegals/" + PARA) { await send(user("paralegal")); return; }
    if (path === "/api/paralegals/saved/" + PARA) { await send({ ownerId: OWNER, paralegalId: PARA, saved: false, revision }); return; }
    if (path === "/api/cases/" + MATTER + "/work-evidence") { await send({ caseId: MATTER, ownerId: OWNER, revision, tasks: [] }); return; }
    if (path.startsWith("/api/notifications")) { await send(path.endsWith("/unread-count") ? { count: 0 } : path.endsWith("/page") ? { items: [], hasMore: false, nextCursor: null } : []); return; }
    const known = {
      "/api/paralegal/dashboard": { activeCases: [state.matter], completedCases: [] },
      "/api/payments/connect/status": { readiness: { ready: true, accountPresent: true, evidenceState: "verified" } },
      "/api/payments/payment-method/default": { paymentMethod: { id: "pm_synthetic_native" } },
      "/api/messages/unread-count": { count: 0 }, "/api/messages/summary": { items: [] }, "/api/messages/threads": { threads: [], total: 0 },
      "/api/users/me/saved-paralegals": { ids: [], items: [], revision },
      "/api/account/2fa": { enabled: false, method: "email", hasBackupCodes: false, sessionManaged: true, securityRevision: revision },
      "/api/account/passkeys": { passkeys: [] }, "/api/account/sessions": { sessions: [], currentSession: null, nextCursor: null, total: 0 },
    };
    if (known[path]) { await send(known[path]); return; }
    // Existing shell's optional background adapters remain explicit. Unknown
    // feature endpoints fail rather than masquerading as working empty data.
    state.unknown.push(call);
    await send({ statusCode: 404, body: { error: "Unconfigured synthetic endpoint: " + path } });
  });
  return state;
}
async function gotoNative(page, url) {
  await page.goto(url);
  // The session marker becomes ready before the boot dialog's font/quiet and
  // fade transitions finish. Wait for native focus to be released before input.
  await page.locator("[data-lpc-boot-screen][open]").waitFor({ state: "detached", timeout: 15000 });
}
module.exports = { OWNER, PARA, MATTER, FILE, PLAN, JOB, DRAFT, MIME, revision, user, matter, preparation, prepSnapshot, workReview, filesReview, installNativeFixture, gotoNative };
