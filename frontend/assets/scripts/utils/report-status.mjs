const REPORT_ID = /^INC-\d{8}-\d{6}$/;
const STATUS = Object.freeze({ received: "Received", investigating: "Under review", testing_fix: "Testing a fix", awaiting_internal_review: "Under review", fixed_live: "Fixed", needs_more_info: "More information needed", closed: "Closed" });
const canceled = () => new DOMException("Canceled", "AbortError");
function node(tag, attributes = {}, children = []) {
  const element = document.createElement(tag);
  for (const [key, value] of Object.entries(attributes)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === "text") element.textContent = value;
    else if (key === "className") element.className = value;
    else element.setAttribute(key, value === true ? "" : value);
  }
  children.filter(Boolean).forEach(child => element.append(child));
  return element;
}
function text(value, maximum = 4000) { return typeof value === "string" && value.length <= maximum ? value.trim() : null; }
function date(value) { return typeof value === "string" && value.length <= 60 && Number.isFinite(new Date(value).getTime()) ? value : null; }
function time(value) { return value ? node("time", { datetime: value, text: new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value)) }) : null; }
export function validReportId(value) { return typeof value === "string" && REPORT_ID.test(value); }
export function readReport(payload, publicId) {
  const value = payload?.incident;
  if (payload?.ok !== true || value?.publicId !== publicId || !Object.hasOwn(STATUS, value?.userVisibleStatus) || !text(value?.summary) || !date(value?.createdAt) || !date(value?.updatedAt)) throw new Error("invalid_report");
  if (value.resolution !== undefined && value.resolution !== null && (typeof value.resolution !== "object" || text(value.resolution.summary) === null)) throw new Error("invalid_resolution");
  // Project only reporter-facing fields. Internal state, codes and payloads never enter the view.
  return { publicId, summary: text(value.summary), status: STATUS[value.userVisibleStatus], createdAt: value.createdAt, updatedAt: value.updatedAt, resolution: text(value.resolution?.summary) || "" };
}
export function readReportUpdates(payload, publicId, after = 0) {
  const report = readReport(payload, publicId);
  if (!Array.isArray(payload.events) || payload.events.length > 20 || typeof payload.hasMore !== "boolean") throw new Error("invalid_updates");
  let last = after;
  const events = payload.events.map(value => {
    if (!Number.isSafeInteger(value?.seq) || value.seq <= last || !text(value.summary, 1000) || !date(value.createdAt)) throw new Error("invalid_update");
    last = value.seq;
    return { seq: value.seq, summary: text(value.summary, 1000), createdAt: value.createdAt };
  });
  if (payload.hasMore ? !events.length || payload.nextCursor !== String(last) : payload.nextCursor !== null) throw new Error("invalid_cursor");
  return { report, events, nextCursor: payload.nextCursor };
}

// Authenticated reporter reader shared by both workspaces. It stores no report or access token.
export function createReportStatusPage(publicId, { api, identity, signal, isCurrent = () => true, onSessionLost, backHref = "#/help", routeAttribute } = {}) {
  const ownerId = String(identity?.id || identity?._id || ""), role = identity?.role;
  let stopped = false, generation = 0, activeRequest = null, report = null, events = [], cursor = null, historyLoaded = false;
  const page = node("section", { className: "lpc-report-status", "aria-labelledby": "lpc-report-title" });
  const refresh = node("button", { type: "button", className: "lpc-report-button", text: "Refresh", "aria-label": "Refresh report" });
  const feedback = node("p", { className: "lpc-report-feedback", role: "status" });
  const current = node("div", { className: "lpc-report-current", "aria-busy": "true" });
  const history = node("details", { className: "lpc-report-history", hidden: true }, [node("summary", { text: "Updates" })]);
  const historyBody = node("div", { className: "lpc-report-history-body" });
  const historyFeedback = node("p", { role: "status", className: "lpc-report-feedback" });
  const more = node("button", { type: "button", className: "lpc-report-button", text: "More updates", hidden: true });
  const back = node("a", { href: backHref, className: "lpc-report-back", text: "Back to Help", ...(routeAttribute ? { [routeAttribute]: "help" } : {}) });
  page.append(back, node("div", { className: "lpc-report-heading" }, [node("h1", { id: "lpc-report-title", text: "Your report" }), refresh]), feedback, current, history);
  history.append(historyBody, historyFeedback, more);
  const live = () => !stopped && !signal?.aborted && isCurrent();
  function dispose() { stopped = true; generation++; activeRequest?.abort(); signal?.removeEventListener("abort", dispose); report = null; events = []; page.replaceChildren(); }
  signal?.addEventListener("abort", dispose, { once: true });
  page.dispose = dispose;
  async function owner(signal) {
    const payload = await api.get("/api/auth/me", { signal }), user = payload?.user;
    if (!live() || signal.aborted) throw canceled();
    if (!/^[a-f\d]{24}$/i.test(ownerId) || !["attorney", "paralegal"].includes(role) || String(user?.id || user?._id || "") !== ownerId || user?.role !== role || user?.status !== "approved" || user?.disabled || user?.deleted) {
      dispose(); onSessionLost?.(); throw canceled();
    }
  }
  async function read(path) {
    const controller = new AbortController(), ticket = generation;
    activeRequest = controller;
    const timer = setTimeout(() => controller.abort(), 30000);
    try {
      await owner(controller.signal);
      const payload = await api.get(`${path}${path.includes("?") ? "&" : "?"}expectedOwnerId=${encodeURIComponent(ownerId)}`, { signal: controller.signal });
      await owner(controller.signal);
      if (!live() || controller.signal.aborted || ticket !== generation) throw canceled();
      return payload;
    } finally { clearTimeout(timer); if (activeRequest === controller) activeRequest = null; }
  }
  function paintReport() {
    current.replaceChildren(node("p", { className: "lpc-report-summary", text: report.summary }), node("span", { className: "lpc-report-badge", text: report.status }), node("dl", { className: "lpc-report-meta" }, [node("dt", { text: "Reference" }), node("dd", { text: report.publicId }), node("dt", { text: "Submitted" }), node("dd", {}, [time(report.createdAt)])]));
    if (report.resolution && ![report.summary, report.status].includes(report.resolution)) current.append(node("p", { className: "lpc-report-resolution", text: report.resolution }));
    history.hidden = false;
  }
  function paintHistory() {
    const list = node("ol", { className: "lpc-report-updates" });
    let previous = "";
    for (const event of events) {
      // Repeated internal transitions can produce the same public sentence; show it once in succession.
      if (event.summary === previous) continue;
      list.append(node("li", { tabindex: "-1", "data-report-update-seq": event.seq }, [node("p", { text: event.summary }), time(event.createdAt)])); previous = event.summary;
    }
    historyBody.replaceChildren(events.length ? list : node("p", { text: "No updates yet." }));
    more.hidden = !cursor; more.textContent = "More updates";
  }
  function busy(value) { refresh.setAttribute("aria-disabled", String(value)); more.setAttribute("aria-disabled", String(value)); }
  function clearReport() {
    const historyHadFocus = history.contains(document.activeElement);
    report = null; events = []; cursor = null; historyLoaded = false;
    current.replaceChildren(); historyBody.replaceChildren(); historyFeedback.textContent = ""; more.hidden = true; history.hidden = true;
    if (historyHadFocus) refresh.focus();
  }
  async function loadHistory() {
    if (!live() || activeRequest || historyLoaded && !cursor) return;
    busy(true); historyFeedback.textContent = "Loading updates…";
    try {
      const suffix = cursor ? `&cursor=${encodeURIComponent(cursor)}` : "";
      const payload = readReportUpdates(await read(`/api/incidents/${publicId}/timeline?paged=1&limit=20${suffix}`), publicId, Number(cursor || 0));
      const moreHadFocus = document.activeElement === more;
      const previousSeq = events.at(-1)?.seq || 0;
      report = payload.report; events.push(...payload.events); cursor = payload.nextCursor; historyLoaded = true;
      paintReport(); paintHistory(); historyFeedback.textContent = "";
      if (moreHadFocus) {
        const rows = [...historyBody.querySelectorAll("[data-report-update-seq]")];
        const target = rows.find(row => Number(row.dataset.reportUpdateSeq) > previousSeq) || (more.hidden ? rows.at(-1) || history.querySelector("summary") : more);
        target.focus({ preventScroll: true });
        target.scrollIntoView({ block: "nearest", behavior: "instant" });
      }
    } catch (error) {
      if (!live()) return;
      if ([401, 403, 404].includes(error.status)) { clearReport(); feedback.textContent = "This report is unavailable to your account."; }
      else { historyFeedback.textContent = "Updates couldn’t load. Try again."; more.hidden = false; more.textContent = "Try again"; }
    } finally { if (live()) busy(false); }
  }
  async function load() {
    if (!live() || activeRequest) return;
    busy(true); current.setAttribute("aria-busy", "true"); feedback.textContent = "Loading report…";
    try {
      if (!validReportId(publicId)) throw Object.assign(new Error("invalid_reference"), { status: 404 });
      report = readReport(await read(`/api/incidents/${publicId}`), publicId);
      events = []; cursor = null; historyLoaded = false; historyBody.replaceChildren(); historyFeedback.textContent = ""; more.hidden = true;
      paintReport(); feedback.textContent = "";
    } catch (error) {
      if (!live()) return;
      clearReport();
      feedback.textContent = [403, 404].includes(error.status) ? "This report is unavailable to your account." : "Your report couldn’t load. Try again.";
    } finally {
      if (live()) { current.setAttribute("aria-busy", "false"); busy(false); }
    }
    if (live() && report && history.open) await loadHistory();
  }
  refresh.addEventListener("click", () => { if (refresh.getAttribute("aria-disabled") !== "true") void load(); });
  more.addEventListener("click", () => { if (more.getAttribute("aria-disabled") !== "true") void loadHistory(); });
  history.addEventListener("toggle", () => { if (history.open && !historyLoaded) void loadHistory(); });
  if (signal?.aborted) dispose();
  page.readiness = load();
  return page;
}
