import { safeMatterReturn, withMatterReturn } from "./router.mjs";
import { createMatterPicker } from '../utils/matter-picker.mjs';
import { renderMatterPayments } from "../utils/matter-financials.mjs";
import { setSupportMatterContext } from "../utils/support-workspace-context.mjs";
import { LpcApiError } from "./api-client.mjs";
import { MATTER_TABS, objectId } from "./deep-links.mjs";
import { createMatterFilesController } from "./matter-files.mjs";
import { createMatterMessagesController } from "./matter-messages.mjs";
import { createMatterDeadlinesController, readMatterDeadlineEvents } from "./matter-deadlines.mjs";
import { createWorkspacePresenceController } from "./workspace-presence.mjs";

const HISTORICAL_STATUSES = new Set(["completed", "closed", "cancelled", "canceled", "expired"]);
const MATTER_POLL_INTERVAL_MS = 15_000;
const MATTER_RECONNECT_DELAY_MS = 5_000;

function node(tag, attributes = {}, children = []) {
  const element = document.createElement(tag);
  Object.entries(attributes).forEach(([name, value]) => {
    if (value === null || value === undefined || value === false) return;
    if (name === "className") element.className = value;
    else if (name === "text") element.textContent = String(value);
    else element.setAttribute(name, value === true ? "" : String(value));
  });
  children.flat().filter(Boolean).forEach((child) => {
    element.append(child instanceof Node ? child : document.createTextNode(String(child)));
  });
  return element;
}

function normalizedStatus(value) {
  return String(value || "").trim().toLowerCase().replace(/_/g, " ");
}

function label(value, fallback = "Not available") {
  const text = String(value || "").trim().replace(/_/g, " ");
  return text ? text.replace(/\b\w/g, (letter) => letter.toUpperCase()) : fallback;
}

function dateLabel(value, fallback = "Not listed") {
  if (!value) return fallback;
  const direct = String(value).slice(0, 10);
  const parsed = /^\d{4}-\d{2}-\d{2}$/.test(direct)
    ? new Date(`${direct}T12:00:00.000Z`)
    : new Date(value);
  if (Number.isNaN(parsed.getTime())) return fallback;
  return parsed.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: /^\d{4}-\d{2}-\d{2}$/.test(direct) ? "UTC" : undefined,
  });
}

function dateTimeLabel(value) {
  const parsed = new Date(value || 0);
  if (Number.isNaN(parsed.getTime())) return "";
  return parsed.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function readOnlyMatter(matter) {
  return matter?.readOnly === true || matter?.archived === true || matter?.paymentReleased === true || HISTORICAL_STATUSES.has(normalizedStatus(matter?.status));
}

function matterStateFingerprint(matter) {
  const work = matter?.matterExperience?.work || {};
  const financials = matter?.matterExperience?.financials || {};
  return JSON.stringify({
    id: objectId(matter?._id || matter?.id),
    updatedAt: String(matter?.updatedAt || ""),
    status: normalizedStatus(matter?.status),
    deadline: String(matter?.deadlineDate || matter?.deadline || ""),
    title: String(matter?.title || ""),
    taskRevision: Number(matter?.taskRevision || 0),
    workCompleted: Number(work.completed || 0),
    workTotal: Number(work.total || 0),
    paymentReleased: matter?.paymentReleased === true,
    financialStatus: String(financials.status || ""),
    financialRevision: String(financials.revision || ""),
  });
}

function stateView(kind, retry) {
  const messages = {
    invalid: ["Matter link unavailable", "This matter address is incomplete or invalid."],
    forbidden: ["You no longer have access to this matter", "Return to My Matters & Applications to see your available work."],
    missing: ["Matter not found", "This matter may no longer be available, or the address may be incorrect."],
    unavailable: ["Matter temporarily unavailable", "LPC could not load this matter right now."],
  };
  const [title, copy] = messages[kind] || messages.unavailable;
  const actions = [node("a", {
    className: "v2-matter-primary-link",
    href: "paralegal-v2.html#/work",
    "data-view": "/work",
    "data-v2-route": "",
    text: "Back to My matters",
  })];
  if (kind === "unavailable" && retry) {
    const button = node("button", { className: "v2-matter-secondary-button", type: "button", text: "Try again" });
    button.addEventListener("click", retry);
    actions.push(button);
  }
  return node("section", { className: "v2-matter-state", "aria-labelledby": "v2-matter-state-title" }, [
    node("p", { className: "v2-matter-kicker", text: "Matter workspace" }),
    node("h1", { id: "v2-matter-state-title", text: title }),
    node("p", { text: copy }),
    node("div", { className: "v2-matter-state-actions" }, actions),
  ]);
}

function fact(term, description) {
  return node("div", {}, [node("dt", { text: term }), node("dd", { text: description })]);
}

function empty(copy) {
  return node("p", { className: "v2-matter-empty", text: copy });
}

function matterSwitcher(currentId, actions, returnTo) {
  const picker = createMatterPicker({
    label: "Switch Matter", triggerLabel: "Switch Matter", dialogTitle: "Switch Matter",
    searchLabelText: "Search assigned Matters", emptyMessage: "No assigned Matters are available.",
    endpoint: "/api/cases/assigned-choices", classPrefix: "v2-choice", formatStatus: (item) => label(item.status),
    allowClear: false, currentId, ownerId: actions.ownerId, api: actions.api, signal: actions.signal,
  });
  picker.element.setAttribute("data-v2-matter-switcher", "");
  picker.input.addEventListener("change", () => {
    const id = objectId(picker.input.value);
    if (actions.isCurrent() && id && id !== currentId) window.location.hash = withMatterReturn(`/matter/${encodeURIComponent(id)}?tab=overview`,returnTo);
  });
  return picker.element;
}

function relationshipLabel(header = {}) {
  return header.relationship === "Assigned paralegal" ? "" : header.relationship || "";
}

function overviewPanel(experience, matter = {}) {
  const overview = experience.overview || {};
  const description = typeof matter.details === "string" && matter.details.trim() ? matter.details : overview.summary;
  const progress = overview.taskProgress || { completed: 0, total: 0 };
  return node("section", { className: "v2-matter-panel v2-matter-overview", "aria-label": "Matter overview" }, [
    description ? node("p", { className: "v2-matter-summary", text: description }) : empty("No matter summary is available."),
    node("dl", { className: "v2-matter-facts" }, [
      fact("Attorney", overview.attorney || "Attorney"),
      fact("Jurisdiction", overview.jurisdiction || "Not listed"),
      fact("Deadline", dateLabel(overview.deadline)),
      fact("Work started", dateLabel(overview.hiredAt)),
      fact("Progress", progress.total ? `${progress.completed} of ${progress.total} work items complete` : "No work items listed"),
    ]),
  ]);
}

function completionHandoff(matter, work) {
  const total = Math.max(0, Number(work?.total) || 0);
  const completedCount = Math.max(0, Number(work?.completed) || 0);
  const allWorkItemsComplete = total > 0 && completedCount >= total;
  const matterCompleted = Boolean(matter?.completedAt) || ["completed", "closed"].includes(normalizedStatus(matter?.status));
  // Historical records do not need active-review instructions. Completion
  // belongs to the Matter header; payment facts belong to Payments.
  if (matterCompleted || readOnlyMatter(matter)) return null;
  if (allWorkItemsComplete) {
    return {
      code: "attorney_completion",
      detail: "Awaiting final attorney review.",
    };
  }
  return {
    code: "attorney_task_review",
    detail: "The attorney marks each item complete after review.",
  };
}

function openWithdrawalDialog({ matter, work, matterId, api, showToast, onWithdrawn, onAccessLost, onSessionLost, trigger }) {
  const withdrawal = work?.withdrawal;
  if (!withdrawal?.allowed || !matterId) return;
  const titleId = `v2-withdraw-title-${matterId}`;
  const cancel = node("button", { className: "v2-matter-dialog-secondary", type: "button", text: "Keep working" });
  const confirm = node("button", { className: "v2-matter-dialog-danger", type: "button", text: "Withdraw from matter" });
  const consequence = withdrawal.outcomeRequiresReview
    ? "Your workspace access will close. The attorney will review the completed work and decide whether a partial payout is appropriate."
    : "Your workspace access will close. Because no work items are complete, no payout will be issued and the matter will be made available again.";
  const dialog = node("dialog", {
    className: "v2-matter-dialog v2-matter-withdraw-dialog",
    "aria-labelledby": titleId,
    "data-v2-route-dialog": "",
    "data-v2-withdraw-dialog": "",
  }, [
    node("div", { className: "v2-matter-dialog-body" }, [
      node("p", { className: "v2-matter-kicker", text: "End assignment" }),
      node("h2", { id: titleId, text: "Withdraw from this matter?" }),
      node("p", { text: `You are about to withdraw from ${matter?.title || "this matter"}. ${consequence}` }),
      node("p", { className: "v2-matter-withdraw-error", role: "alert", "aria-live": "assertive", "data-v2-withdraw-error": "" }),
    ]),
    node("footer", {}, [cancel, confirm]),
  ]);
  cancel.addEventListener("click", () => dialog.close());
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) dialog.close();
  });
  confirm.addEventListener("click", async () => {
    if (confirm.disabled) return;
    confirm.disabled = true;
    cancel.disabled = true;
    confirm.textContent = "Withdrawing…";
    const errorNode = dialog.querySelector("[data-v2-withdraw-error]");
    if (errorNode) errorNode.textContent = "";
    try {
      const result = await api.post(`/api/cases/${encodeURIComponent(matterId)}/withdraw`, {});
      dialog.close("confirmed");
      showToast?.(result?.message || "You withdrew from this matter.");
      onWithdrawn?.(matterId, result);
    } catch (error) {
      if (error instanceof LpcApiError && error.status === 401) {
        dialog.close();
        onSessionLost?.();
        return;
      }
      if (error instanceof LpcApiError && [403, 404].includes(error.status)) {
        dialog.close();
        onAccessLost?.(matterId);
        return;
      }
      if (errorNode) errorNode.textContent = error?.message || "The withdrawal could not be completed. Refresh and try again.";
      confirm.disabled = false;
      cancel.disabled = false;
      confirm.textContent = "Withdraw from matter";
    }
  });
  dialog.addEventListener("close", () => {
    dialog.remove();
    if (dialog.returnValue !== "confirmed") trigger?.focus({ preventScroll: true });
  }, { once: true });
  document.querySelector("[data-v2-dialog-host]")?.append(dialog);
  dialog.showModal();
  cancel.focus();
}

function openDisputeDialog({ matter, matterId, api, showToast, onDisputed, onAccessLost, onSessionLost, trigger }) {
  if (!matterId) return;
  const titleId = `v2-dispute-title-${matterId}`;
  const detailsId = `v2-dispute-details-${matterId}`;
  const cancel = node("button", { className: "v2-matter-dialog-secondary", type: "button", text: "Cancel" });
  const confirm = node("button", { className: "v2-matter-dialog-danger", type: "button", text: "Open dispute" });
  const details = node("textarea", {
    id: detailsId,
    rows: "4",
    maxlength: "4000",
    placeholder: "Add details for LPC’s review (optional)",
  });
  const dialog = node("dialog", {
    className: "v2-matter-dialog v2-matter-dispute-dialog",
    "aria-labelledby": titleId,
    "data-v2-route-dialog": "",
    "data-v2-dispute-dialog": "",
  }, [
    node("div", { className: "v2-matter-dialog-body" }, [
      node("p", { className: "v2-matter-kicker", text: "Request LPC review" }),
      node("h2", { id: titleId, text: "Open a dispute?" }),
      node("p", { text: `Opening a dispute for ${matter?.title || "this matter"} pauses the workspace for both parties while LPC reviews it.` }),
      node("label", { for: detailsId, text: "What should LPC know?" }),
      details,
      node("p", { className: "v2-matter-withdraw-error", role: "alert", "aria-live": "assertive", "data-v2-dispute-error": "" }),
    ]),
    node("footer", {}, [cancel, confirm]),
  ]);
  cancel.addEventListener("click", () => dialog.close());
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) dialog.close();
  });
  confirm.addEventListener("click", async () => {
    if (confirm.disabled) return;
    confirm.disabled = true;
    cancel.disabled = true;
    confirm.textContent = "Opening…";
    const errorNode = dialog.querySelector("[data-v2-dispute-error]");
    if (errorNode) errorNode.textContent = "";
    try {
      const message = String(details.value || "").trim() || "Dispute opened from the matter workspace.";
      const result = await api.post(`/api/disputes/${encodeURIComponent(matterId)}`, { message });
      dialog.close("confirmed");
      showToast?.("The dispute is open and the matter is paused for review.");
      onDisputed?.(matterId, result);
    } catch (error) {
      if (error instanceof LpcApiError && error.status === 401) {
        dialog.close();
        onSessionLost?.();
        return;
      }
      if (error instanceof LpcApiError && [403, 404].includes(error.status)) {
        dialog.close();
        onAccessLost?.(matterId);
        return;
      }
      if (errorNode) errorNode.textContent = error?.message || "The dispute could not be opened. Refresh and try again.";
      confirm.disabled = false;
      cancel.disabled = false;
      confirm.textContent = "Open dispute";
    }
  });
  dialog.addEventListener("close", () => {
    dialog.remove();
    if (dialog.returnValue !== "confirmed") trigger?.focus({ preventScroll: true });
  }, { once: true });
  document.querySelector("[data-v2-dialog-host]")?.append(dialog);
  dialog.showModal();
  cancel.focus();
}

function workPanel(matter, experience, context = {}) {
  const work = experience.work || { tasks: [], completed: 0, total: 0 };
  const tasks = Array.isArray(work.tasks) ? work.tasks : [];
  const handoff = completionHandoff(matter, work);
  const withdraw = work.withdrawal?.allowed ? node("button", {
    className: "v2-matter-withdraw-action",
    type: "button",
    "data-v2-withdraw-matter": "",
    text: "Withdraw from matter",
  }) : null;
  const dispute = work.dispute?.allowed ? node("button", {
    className: "v2-matter-dispute-action",
    type: "button",
    "data-v2-open-dispute": "",
    text: "Open dispute",
  }) : null;
  withdraw?.addEventListener("click", () => openWithdrawalDialog({
    matter,
    work,
    matterId: context.matterId,
    api: context.api,
    showToast: context.showToast,
    onWithdrawn: context.onWithdrawn,
    onAccessLost: context.onAccessLost,
    onSessionLost: context.onSessionLost,
    trigger: withdraw,
  }));
  dispute?.addEventListener("click", () => openDisputeDialog({
    matter,
    matterId: context.matterId,
    api: context.api,
    showToast: context.showToast,
    onDisputed: context.onDisputed,
    onAccessLost: context.onAccessLost,
    onSessionLost: context.onSessionLost,
    trigger: dispute,
  }));
  return node("section", { className: "v2-matter-panel", "aria-labelledby": "v2-matter-work-title" }, [
    node("div", { className: "v2-matter-panel-heading" }, [
      node("div", {}, [node("h2", { id: "v2-matter-work-title", text: "Work" })]),
      work.total ? node("span", { className: "v2-matter-panel-note", text: `${work.completed} of ${work.total} complete` }) : null,
    ]),
    tasks.length ? node("ol", { className: "v2-matter-task-list" }, tasks.map((task) => node("li", { className: task.completed ? "is-complete" : "" }, [
      node("span", { className: "v2-matter-task-mark", "aria-hidden": "true", text: task.completed ? "✓" : "" }),
      node("span", { text: task.title || "Work item" }),
      node("small", { text: task.completed ? "Complete" : "In progress" }),
    ]))) : empty("No work items are listed for this matter."),
    handoff?.detail ? node("aside", {
      className: `v2-matter-completion-handoff is-${handoff.code}`,
      "data-completion-state": handoff.code,
      "aria-label": "Matter completion status",
    }, [
      node("span", { text: handoff.detail }),
    ]) : null,
    withdraw || dispute ? node("details", { className: "v2-matter-options" }, [
      node("summary", { text: "Matter options" }),
      withdraw ? node("div", { className: "v2-matter-withdraw-row" }, [
        node("p", { text: "Review withdrawal and payout details before leaving this matter." }),
        withdraw,
      ]) : null,
      dispute ? node("div", { className: "v2-matter-dispute-row" }, [
        node("p", { text: "Open a dispute to pause this matter for LPC review." }),
        dispute,
      ]) : null,
    ]) : null,
  ]);
}

function activityPanel(experience) {
  const activity = Array.isArray(experience.activity) ? experience.activity : [];
  return node("section", { className: "v2-matter-panel", "aria-labelledby": "v2-matter-history-title" }, [
    node("div", { className: "v2-matter-panel-heading" }, [
      node("div", {}, [node("h2", { id: "v2-matter-history-title", text: "History" })]),
    ]),
    activity.length ? node("ol", { className: "v2-matter-history-list" }, activity.map((item) => node("li", {}, [
      node("span", { "aria-hidden": "true" }),
      node("div", {}, [node("strong", { text: item.label || label(item.code, "Matter updated") }), node("time", { datetime: item.at || "", text: dateTimeLabel(item.at) })]),
    ]))) : empty("No matter history is available."),
  ]);
}

function financialPanel(experience, context) {
  return node("section", { className: "v2-matter-panel", "aria-labelledby": "v2-matter-financial-title" }, [
    node("div", { className: "v2-matter-panel-heading" }, [node("h2", { id: "v2-matter-financial-title", text: "Payments" })]),
    renderMatterPayments(experience.financials, { ownerId: context.ownerId, caseId: context.matterId, role: "paralegal", api: context.api, signal: context.signal, isCurrent: context.isCurrent, onRefresh: context.onRefresh }),
  ]);
}

function applicationPanel(experience) {
  const applications = experience.applications?.items || [];
  return node("section", { className: "v2-matter-panel", "aria-labelledby": "v2-matter-application-title" }, [
    node("div", { className: "v2-matter-panel-heading" }, [
      node("div", {}, [node("h2", { id: "v2-matter-application-title", text: "Application" })]),
    ]),
    applications.length ? node("div", { className: "v2-matter-application-list" }, applications.map((item) => node("article", {}, [
      node("strong", { text: item.name || "Your application" }),
      node("span", { text: label(item.status, "Submitted") }),
      node("time", { datetime: item.appliedAt || "", text: dateLabel(item.appliedAt, "Date unavailable") }),
    ]))) : empty("No application information is available."),
  ]);
}

function panelFor(tab, context) {
  if (tab === "overview") return overviewPanel(context.experience, context.matter);
  if (tab === "applications") return applicationPanel(context.experience);
  if (tab === "work") return workPanel(context.matter, context.experience, context);
  if (tab === "files") return context.fileController.panel({
    matterId: context.matterId,
    filesResult: context.files,
    highlightedFileId: context.fileId,
    writable: context.filesWritable,
    historical: context.historical,
  });
  if (tab === "messages") return context.messageController.panel({
    matterId: context.matterId,
    messagesResult: context.messages,
    filesResult: context.files,
    highlightedMessageId: context.messageId,
    highlightedFileId: context.fileId,
    writable: context.messagesWritable,
    historical: context.historical,
  });
  if (tab === "deadlines") return context.deadlineController.panel({
    matterId: context.matterId,
    ownerId: context.ownerId,
    matterDeadline: context.experience.overview?.deadline || context.experience.header?.deadline || context.matter.deadlineDate || context.matter.deadline,
    eventsResult: context.deadlines,
    highlightedEventId: context.eventId,
    writable: context.deadlinesWritable,
  });
  if (tab === "activity") return activityPanel(context.experience);
  if (tab === "financials") return financialPanel(context.experience, context);
  return overviewPanel(context.experience, context.matter);
}

function workspace(matter, route, messages, files, deadlines, messageController, fileController, deadlineController, actions) {
  const experience = matter.matterExperience || {};
  const header = experience.header || {};
  const sectionIds = new Set((experience.sections || []).map((section) => section.id));
  sectionIds.add("overview");
  const requested = String(route.query.get("tab") || "overview").toLowerCase();
  const tab = MATTER_TABS.has(requested) && sectionIds.has(requested) ? requested : "overview";
  const historical = readOnlyMatter(matter);
  const tabs = (experience.sections || [{ id: "overview", label: "Overview" }]).filter((section) => sectionIds.has(section.id));
  const id = objectId(route.params.matterId);
  const returnTo = safeMatterReturn(route.query.get("returnTo")) || "/work";
  const nextAction = header.primaryAction;
  const nextHref = nextAction && MATTER_TABS.has(nextAction.tab) && sectionIds.has(nextAction.tab) && nextAction.tab !== tab
    ? withMatterReturn(`/matter/${encodeURIComponent(id)}?tab=${encodeURIComponent(nextAction.tab)}`, returnTo) : null;
  const root = node("section", {
    className: "v2-matter",
    "data-v2-matter": "",
    "data-matter-id": id,
    "data-matter-fingerprint": matterStateFingerprint(matter),
    "data-workspace-presence": historical ? "inactive" : "active",
    "aria-labelledby": "v2-matter-title",
  }, [
    node("div", { className: "v2-matter-navigation" }, [
      node("a", { className: "v2-matter-back", href: `paralegal-v2.html#${returnTo}`, "data-view": returnTo, "data-v2-route": "", text: returnTo === "/home" || /^\/home\?view=(overview|pulse|inbox)(?:&|$)/.test(returnTo) ? "Back to Home" : "Back to Matters" }),
      matterSwitcher(id, actions, returnTo),
    ]),
    node("header", { className: "v2-matter-header" }, [
      node("div", {}, [
        node("p", { className: "v2-matter-kicker", text: [relationshipLabel(header), header.practiceArea || experience.overview?.practiceArea].filter(Boolean).join(" · ") || "Matter workspace" }),
        node("h1", { id: "v2-matter-title", text: header.title || matter.title || "Matter" }),
        node("p", { className: "v2-matter-header-facts", text: [
          experience.overview?.attorney ? `Attorney: ${experience.overview.attorney}` : "",
          header.deadline || experience.overview?.deadline ? `Due ${dateLabel(header.deadline || experience.overview.deadline, "Date unavailable")}` : "",
        ].filter(Boolean).join(" · ") }),
      ]),
      node("div", { className: "v2-matter-header-status" }, [
        header.attention ? node("span", { className: "v2-matter-attention", text: header.attention }) : null,
        node("span", { className: "v2-matter-status", text: header.status?.label || label(matter.status) }),
      ]),
    ]),
    nextHref ? node("div", { className: "v2-matter-next-action" }, [
      node("a", { className: "v2-matter-secondary-button", href: `paralegal-v2.html#${nextHref}`, "data-view": nextHref, "data-v2-route": "", text: nextAction.label }),
      nextAction.detail ? node("span", { text: nextAction.detail }) : null,
    ]) : null,
    historical ? node("aside", { className: "v2-matter-readonly", role: "status" }, [
      node("strong", { text: "Read-only record" }),
    ]) : null,
    node("nav", { className: "v2-matter-tabs", "aria-label": "Matter workspace sections" }, tabs.map((section) => {
      const selected = section.id === tab;
      const display = section.id === "financials" ? "Financials" : section.id === "activity" ? "Activity" : section.id === "files" ? "Files" : section.label;
      return node("a", {
        href: `paralegal-v2.html#${withMatterReturn(`/matter/${encodeURIComponent(id)}?tab=${encodeURIComponent(section.id)}`,returnTo)}`,
        "data-view": withMatterReturn(`/matter/${id}?tab=${section.id}`,returnTo),
        "data-v2-route": "",
        "data-matter-tab": section.id,
        ...(selected ? { "aria-current": "page" } : {}),
        text: display,
      });
    })),
    panelFor(tab, {
      matter,
      experience,
      messages,
      files,
      deadlines,
      matterId: id,
      messageController,
      fileController,
      deadlineController,
      api: actions.api,
      ownerId: actions.ownerId,
      signal: actions.signal,
      isCurrent: actions.isCurrent,
      onRefresh: actions.onRefresh,
      showToast: actions.showToast,
      onWithdrawn: actions.onWithdrawn,
      onDisputed: actions.onDisputed,
      onAccessLost: actions.onAccessLost,
      onSessionLost: actions.onSessionLost,
      messagesWritable: !historical && experience.work?.readOnly !== true && !messages?.unavailable,
      filesWritable: !historical && experience.work?.readOnly !== true && !files?.unavailable,
      deadlinesWritable: !historical && experience.work?.readOnly !== true,
      historical,
      fileId: objectId(route.query.get("fileId")),
      messageId: objectId(route.query.get("messageId")),
      eventId: objectId(route.query.get("eventId")),
    }),
  ]);
  return root;
}

export function createMatterView({ api, getIdentity, showToast, onAccessLost, onSessionLost, onMessagesChanged, onFilesChanged, onDeadlinesChanged, onMatterChanged, onMatterWithdrawn } = {}) {
  let controller = null;
  let currentRoot = null, tabObserver = null;
  let clearAssistantContext = () => {};
  let matterEventSource = null;
  let matterReconnectTimer = null;
  let matterPollTimer = null;
  let matterRefreshTimer = null;
  let activeMatterId = "";
  let activeMatterFingerprint = "";
  const messageController = createMatterMessagesController({
    api,
    getIdentity,
    onAccessLost,
    onSessionLost,
    onChanged: onMessagesChanged,
    onMatterChanged,
    onFilesChanged,
  });
  const fileController = createMatterFilesController({
    api,
    onAccessLost,
    onSessionLost,
    onChanged: onFilesChanged,
    onMatterChanged,
  });
  const deadlineController = createMatterDeadlinesController({
    api,
    getIdentity,
    onAccessLost,
    onSessionLost,
    onChanged: onDeadlinesChanged,
    onMatterChanged,
  });
  const presenceController = createWorkspacePresenceController({ api });

  function leave() {
    tabObserver?.disconnect(); tabObserver = null; currentRoot = null;
    clearAssistantContext();
    controller?.abort();
    controller = null;
    matterEventSource?.close();
    matterEventSource = null;
    if (matterReconnectTimer) window.clearTimeout(matterReconnectTimer);
    if (matterPollTimer) window.clearInterval(matterPollTimer);
    if (matterRefreshTimer) window.clearTimeout(matterRefreshTimer);
    matterReconnectTimer = null;
    matterPollTimer = null;
    matterRefreshTimer = null;
    activeMatterId = "";
    activeMatterFingerprint = "";
    messageController.leave();
    fileController.leave();
    deadlineController.leave();
    presenceController.stop();
  }

  // Normal departure also disposes streams and reads; pageshow reauthorizes
  // and remounts a restored workspace through the existing shell lifecycle.
  window.addEventListener("pagehide", leave);

  async function render({ route, isCurrent, onRetry } = {}) {
    leave();
    const id = objectId(route?.params?.matterId);
    if (!id) return stateView("invalid");
    controller = new AbortController();
    const signal = controller.signal;
    try {
      const ownerId = objectId(getIdentity?.()?.id || getIdentity?.()?._id);
      const matter = await api.get(`/api/cases/${encodeURIComponent(id)}?${new URLSearchParams({ expectedOwnerId: ownerId || "" })}`, { signal });
      if (!isCurrent() || signal.aborted) return null;
      const experience = matter?.matterExperience;
      if (!experience || !Array.isArray(experience.sections)) return stateView("unavailable", onRetry);

      const requestedTab = String(route.query.get("tab") || "overview").toLowerCase();
      const canReadMessages = experience.sections.some((section) => section.id === "messages");
      const canReadFiles = experience.sections.some((section) => section.id === "files");
      const canReadDeadlines = experience.sections.some((section) => section.id === "deadlines");
      const historical = readOnlyMatter(matter);
      let messages = null;
      let files = null;
      let deadlines = null;
      if (requestedTab === "messages" && canReadMessages) {
        try {
          messages = await api.get(`/api/messages/${encodeURIComponent(id)}`, { signal });
        } catch (error) {
          if (error?.name === "AbortError") throw error;
          if (error instanceof LpcApiError && error.status === 401) throw error;
          if (error instanceof LpcApiError && [403, 404].includes(error.status)) {
            messages = { unavailable: true, message: error.message };
          } else {
            messages = { unavailable: true, message: "Messages could not be loaded right now." };
          }
        }
      }
      if (["messages", "files"].includes(requestedTab) && canReadFiles) {
        if (historical) {
          files = { files: Array.isArray(matter.files) ? matter.files : [], historical: true };
        } else {
          try {
            files = await api.get(`/api/uploads/case/${encodeURIComponent(id)}?presentation=matter`, { signal });
          } catch (error) {
            if (error?.name === "AbortError") throw error;
            if (error instanceof LpcApiError && error.status === 401) throw error;
            files = {
              unavailable: true,
              message: error instanceof LpcApiError && [403, 404].includes(error.status)
                ? error.message
                : "Files could not be loaded right now.",
            };
          }
        }
      }
      if (requestedTab === "deadlines" && canReadDeadlines) {
        try {
          deadlines = await readMatterDeadlineEvents(api, id, ownerId, { signal, eventId: objectId(route.query.get("eventId")) || "" });
        } catch (error) {
          if (error?.name === "AbortError") throw error;
          if (error instanceof LpcApiError && [401, 403, 404].includes(error.status)) throw error;
          deadlines = { unavailable: true, message: "Private reminders could not be loaded right now." };
        }
      }
      if (!isCurrent() || signal.aborted) return null;
      const availableTabs = experience.sections.map(section => section.id);
      clearAssistantContext = setSupportMatterContext({ ownerId: getIdentity?.()?.id || getIdentity?.()?._id, role: "paralegal", matterId: matter.id || matter._id, routeMatterId: id, currentTab: availableTabs.includes(requestedTab) ? requestedTab : "overview", availableMatterTabs: availableTabs, status: matter.status, relationship: experience.header?.relationship, signal });
      return workspace(
        matter,
        route,
        messages,
        files,
        deadlines,
        messageController,
        fileController,
        deadlineController,
        {
          api,
          ownerId,
          signal,
          isCurrent: () => isCurrent() && !signal.aborted && ownerId === objectId(getIdentity?.()?.id || getIdentity?.()?._id),
          onRefresh: onRetry,
          showToast,
          onAccessLost(matterId) {
            leave();
            onAccessLost?.(matterId);
            window.location.hash = "/work";
          },
          onSessionLost,
          onWithdrawn(matterId, result) {
            leave();
            onMatterWithdrawn?.(matterId, result);
            window.location.hash = `/work?section=history&matterId=${encodeURIComponent(matterId)}`;
          },
          onDisputed(matterId) {
            leave();
            onMatterChanged?.(matterId);
            window.location.hash = `/work?section=history&matterId=${encodeURIComponent(matterId)}`;
          },
        }
      );
    } catch (error) {
      if (signal.aborted || !isCurrent() || error?.name === "AbortError") return null;
      if (error instanceof LpcApiError && error.status === 401) {
        onSessionLost?.();
        return stateView("forbidden");
      }
      if (error instanceof LpcApiError && error.status === 403) {
        onAccessLost?.(id);
        return stateView("forbidden");
      }
      if (error instanceof LpcApiError && error.status === 404) {
        onAccessLost?.(id);
        return stateView("missing");
      }
      return stateView("unavailable", onRetry);
    }
  }

  function afterMount(root) {
    messageController.afterMount(root);
    fileController.afterMount(root);
    deadlineController.afterMount(root);
    const matterRoot = root?.matches?.("[data-v2-matter]") ? root : root?.querySelector?.("[data-v2-matter]");
    const matterId = objectId(matterRoot?.dataset?.matterId);
    if (!matterId) return;
    currentRoot = matterRoot;
    const tabs = matterRoot.querySelector(".v2-matter-tabs");
    if (tabs) {
      const keepActiveTabVisible = () => {
        const focused = document.activeElement?.closest?.("[data-matter-tab]");
        const selected = focused && tabs.contains(focused) ? focused : tabs.querySelector("[aria-current='page']");
        if (!selected || !tabs.isConnected) return;
        const frame = tabs.getBoundingClientRect(), active = selected.getBoundingClientRect();
        if (active.right > frame.right) tabs.scrollLeft += active.right - frame.right;
        else if (active.left < frame.left) tabs.scrollLeft -= frame.left - active.left;
      };
      tabs.addEventListener("focusin", keepActiveTabVisible);
      keepActiveTabVisible(); tabObserver = new ResizeObserver(keepActiveTabVisible); tabObserver.observe(tabs);
    }
    activeMatterId = matterId;
    activeMatterFingerprint = String(matterRoot.dataset.matterFingerprint || "");
    const selectedTab = root.querySelector?.(".v2-matter-tabs [aria-current='page']")?.dataset?.matterTab || "overview";
    presenceController.start(matterId, {
      enabled: matterRoot.dataset.workspacePresence === "active",
      surface: selectedTab,
    });
    // Messages and Files own a single reconnecting Matter stream so their
    // records can update without replacing the workspace. All other tabs use
    // this overview stream for Matter/task changes.
    if (["messages", "files"].includes(selectedTab)) return;

    const handleAccessError = (error) => {
      if (error instanceof LpcApiError && error.status === 401) {
        onSessionLost?.();
        return true;
      }
      if (error instanceof LpcApiError && [403, 404].includes(error.status)) {
        leave();
        onAccessLost?.(matterId);
        window.location.hash = "/work";
        return true;
      }
      return false;
    };
    const signal = controller?.signal;
    const reconcile = async () => {
      if (!signal || signal.aborted || activeMatterId !== matterId) return;
      try {
        const ownerId = objectId(getIdentity?.()?.id || getIdentity?.()?._id);
        const latest = await api.get(`/api/cases/${encodeURIComponent(matterId)}?${new URLSearchParams({ expectedOwnerId: ownerId || "" })}`, { signal });
        if (signal.aborted || activeMatterId !== matterId) return;
        const fingerprint = matterStateFingerprint(latest);
        if (fingerprint === activeMatterFingerprint) return;
        activeMatterFingerprint = fingerprint;
        onMatterChanged?.();
      } catch (error) {
        if (signal.aborted || activeMatterId !== matterId || error?.name === "AbortError") return;
        if (!handleAccessError(error)) matterRoot.querySelector("[data-matter-payments]")?.clear?.("Payment details could not be refreshed. Refresh to try again.");
      }
    };
    const scheduleReconcile = () => {
      if (activeMatterId !== matterId || matterRefreshTimer) return;
      matterRefreshTimer = window.setTimeout(() => {
        matterRefreshTimer = null;
        void reconcile();
      }, 100);
    };
    const startPolling = () => {
      if (matterPollTimer || activeMatterId !== matterId) return;
      matterPollTimer = window.setInterval(() => {
        if (document.visibilityState === "visible") scheduleReconcile();
      }, MATTER_POLL_INTERVAL_MS);
    };
    const startStream = () => {
      if (activeMatterId !== matterId || matterEventSource) return;
      if (typeof EventSource !== "function") {
        startPolling();
        return;
      }
      const source = new EventSource(`/api/cases/${encodeURIComponent(matterId)}/stream`);
      matterEventSource = source;
      source.addEventListener("open", () => {
        // Reconcile immediately after every connection or reconnection so an
        // event emitted while the stream was unavailable cannot leave this
        // workspace stale indefinitely.
        scheduleReconcile();
      });
      source.addEventListener("tasks", scheduleReconcile);
      source.addEventListener("case", scheduleReconcile);
      source.addEventListener("error", () => {
        if (matterEventSource !== source) return;
        source.close();
        matterEventSource = null;
        startPolling();
        matterReconnectTimer = window.setTimeout(() => {
          matterReconnectTimer = null;
          startStream();
        }, MATTER_RECONNECT_DELAY_MS);
      });
    };
    // Retain the low-frequency fingerprint check while the live stream is
    // connected so changes from a separate process are still reconciled.
    startPolling();
    startStream();
  }

  return Object.freeze({
    render,
    afterMount,
    leave,
    hasPendingDownload() { return !!currentRoot?.querySelector("[data-payout-receipt]:disabled"); },
    hasDrafts() {
      return messageController.hasDrafts() || fileController.hasDrafts() || deadlineController.hasDrafts();
    },
    clearDrafts() {
      messageController.clearDrafts();
      fileController.clearDrafts();
      deadlineController.clearDrafts();
    },
  });
}
