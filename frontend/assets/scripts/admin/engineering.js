import { secureFetch } from "../auth.js";

const state = {
  overview: null,
  items: [],
  activeItemId: "",
  detail: null,
  listLoading: false,
  detailLoading: false,
  pendingActionKey: "",
  archivedResolvedIds: new Set(),
};

function escapeHTML(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function readJsonOrThrow(res, fallbackMessage) {
  return res.json().catch(() => ({})).then((payload) => {
    if (!res.ok) {
      throw new Error(payload?.error || payload?.message || fallbackMessage);
    }
    return payload;
  });
}

function getItemIdentifier(item = {}) {
  return String(item.publicId || item.id || item.incident?.publicId || item.incident?.id || "").trim();
}

function formatDateTime(value) {
  if (!value) return "Not available";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Not available";
  return date.toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function formatDuration(value) {
  if (!value) return "Unknown";
  const openedAt = new Date(value);
  if (Number.isNaN(openedAt.getTime())) return "Unknown";
  const diffMs = Math.max(0, Date.now() - openedAt.getTime());
  const totalMinutes = Math.floor(diffMs / 60000);
  if (totalMinutes < 1) return "Just now";
  if (totalMinutes < 60) return `${totalMinutes}m`;
  const totalHours = Math.floor(totalMinutes / 60);
  if (totalHours < 24) {
    const remainingMinutes = totalMinutes % 60;
    return remainingMinutes ? `${totalHours}h ${remainingMinutes}m` : `${totalHours}h`;
  }
  const totalDays = Math.floor(totalHours / 24);
  const remainingHours = totalHours % 24;
  return remainingHours ? `${totalDays}d ${remainingHours}h` : `${totalDays}d`;
}

function getToneClass(tone = "") {
  const normalized = String(tone || "").trim().toLowerCase();
  if (normalized === "healthy") return "ai-room-badge ai-room-badge--healthy";
  if (normalized === "blocked") return "ai-room-badge ai-room-badge--blocked";
  if (normalized === "needs-review") return "ai-room-badge ai-room-badge--needs-review";
  if (normalized === "priority") return "ai-room-badge ai-room-badge--priority";
  return "ai-room-badge ai-room-badge--active";
}

function getUrgencyClass(level = "") {
  const normalized = String(level || "").trim().toLowerCase();
  return `engineering-urgency-chip engineering-urgency-chip--${normalized || "low"}`;
}

function getActionButtonClass(action, className = "") {
  if (className) return className;
  const emphasis = String(action?.emphasis || "").trim().toLowerCase();
  if (emphasis === "success") return "btn engineering-action-btn engineering-action-btn--success";
  if (emphasis === "priority") return "btn engineering-action-btn engineering-action-btn--priority";
  if (emphasis === "active") return "btn engineering-action-btn engineering-action-btn--active";
  return "btn";
}

function getVisibleQueueItems(items = []) {
  const list = Array.isArray(items) ? items : [];
  return list.filter((item) => {
    const identifier = getItemIdentifier(item);
    return !(item.engineeringStatus === "Resolved" && state.archivedResolvedIds.has(identifier));
  });
}

async function copyTextToClipboard(text = "") {
  const value = String(text || "");
  if (!value) throw new Error("No CTO fix prompt is attached yet.");
  if (navigator?.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }

  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.setAttribute("readonly", "readonly");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand("copy");
  document.body.removeChild(textarea);
}

function renderList(values = [], emptyMessage = "Nothing is available yet.") {
  const items = (Array.isArray(values) ? values : []).filter(Boolean);
  if (!items.length) return `<p class="engineering-detail-note">${escapeHTML(emptyMessage)}</p>`;
  return `<ul>${items.map((value) => `<li>${escapeHTML(value)}</li>`).join("")}</ul>`;
}

function renderMetaItem(label, value) {
  return `
    <div class="engineering-detail-meta-item">
      <span class="engineering-detail-meta-label">${escapeHTML(label)}</span>
      <span class="engineering-detail-meta-value">${escapeHTML(value || "-")}</span>
    </div>
  `;
}

function renderActionButton(action, className = "") {
  if (!action || action.enabled === false) return "";
  const pending = state.pendingActionKey === `${action.actionType}:${action.incidentId || action.ticketId || action.href || ""}`;
  const attrs = [
    `class="${escapeHTML(getActionButtonClass(action, className))}"`,
    'type="button"',
    `data-engineering-action="${escapeHTML(action.actionType || "")}"`,
  ];
  if (action.incidentId) attrs.push(`data-incident-id="${escapeHTML(action.incidentId)}"`);
  if (action.ticketId) attrs.push(`data-ticket-id="${escapeHTML(action.ticketId)}"`);
  if (action.href) attrs.push(`data-href="${escapeHTML(action.href)}"`);
  if (pending) attrs.push("disabled");
  return `<button ${attrs.join(" ")}>${escapeHTML(pending ? "Working..." : action.label || "Open")}</button>`;
}

function setWorkspaceStatus(message = "", tone = "muted") {
  const status = document.getElementById("engineeringWorkspaceStatus");
  if (!status) return;
  status.textContent = message || "";
  status.dataset.tone = tone;
}

function renderSummaryTile(id, value, note) {
  const root = document.getElementById(id);
  if (!root) return;
  const valueEl = root.querySelector(".ai-room-summary-value");
  const noteEl = root.querySelector(".ai-room-summary-note");
  if (valueEl) valueEl.textContent = String(value ?? "0");
  if (noteEl) noteEl.textContent = note || "";
}

function renderOverview(overview) {
  const summary = overview?.summary || {};
  const badge = document.getElementById("engineeringRefreshBadge");
  const timestamp = document.getElementById("engineeringTimestamp");
  const recommendation = document.getElementById("engineeringRecommendation");
  const guardrail = document.getElementById("engineeringGuardrailText");

  renderSummaryTile(
    "engineeringSummaryActive",
    summary.activeCount || 0,
    "Open engineering items currently in view."
  );
  renderSummaryTile(
    "engineeringSummaryBlocked",
    summary.blockedCount || 0,
    "Items blocked by uncertainty, failed verification, or required human intervention."
  );
  renderSummaryTile(
    "engineeringSummaryApproval",
    summary.awaitingApprovalCount || 0,
    "Items paused on approval or manual release review."
  );
  renderSummaryTile(
    "engineeringSummaryReady",
    summary.readyForTestCount || 0,
    `Items close to resolution and mainly waiting on test verification. ${summary.resolvedTodayCount || 0} resolved today.`
  );

  if (badge) badge.textContent = state.listLoading ? "Loading live data" : "Live engineering queue";
  if (timestamp) {
    timestamp.textContent = overview?.generatedAt
      ? `Updated ${formatDateTime(overview.generatedAt)}`
      : `Updated ${formatDateTime(new Date())}`;
  }
  if (recommendation) recommendation.textContent = summary.recommendation || "No engineering recommendation is available yet.";
  if (guardrail) guardrail.textContent = summary.guardrail || "No auto-deploy. Manual review still applies.";
}

function renderQuickActions(actions = []) {
  const root = document.getElementById("engineeringQuickActionList");
  if (!root) return;
  if (!actions.length) {
    root.innerHTML = '<div class="ai-room-empty">Quick actions will appear here when the engineering queue loads.</div>';
    return;
  }

  root.innerHTML = actions
    .map(
      (action) => `
        <article class="ai-room-list-item engineering-quick-action">
          <div class="ai-room-list-item-top">
            <strong class="ai-room-list-item-title">${escapeHTML(action.label || "Action")}</strong>
          </div>
          <p>${escapeHTML(action.description || "Manual admin action.")}</p>
          <div class="engineering-action-row">
            ${renderActionButton(action)}
          </div>
        </article>
      `
    )
    .join("");
}

function renderQueue(items = []) {
  const root = document.getElementById("engineeringQueueList");
  if (!root) return;
  const visibleItems = getVisibleQueueItems(items);
  if (!visibleItems.length) {
    if (Array.isArray(items) && items.length) {
      root.innerHTML = '<div class="ai-room-empty">All visible incidents in this queue are resolved or archived.</div>';
      return;
    }
    root.innerHTML = '<div class="ai-room-empty">No engineering items are visible yet.</div>';
    return;
  }

  root.innerHTML = visibleItems
    .map((item) => {
      const identifier = getItemIdentifier(item);
      const isActive = state.activeItemId === identifier;
      const urgency = item.urgency || {};
      const openForLabel = item.createdAt ? `Open ${formatDuration(item.createdAt)}` : "Open time unknown";
      const meta = [
        item.publicId || "",
        item.sourceContextLabel || "Incident-linked engineering item",
        item.risk?.level ? `${item.risk.level} risk` : "",
        item.lastReportedAt ? `Last reported ${formatDateTime(item.lastReportedAt)}` : "",
      ].filter(Boolean);
      const reportDelta = item.additionalSupportReportLabel || "";

      return `
        <article class="ai-room-list-item support-list-card engineering-list-card engineering-list-card--${escapeHTML(urgency.visualLevel || "low")} ${isActive ? "support-list-card--active is-active" : ""}">
          <button class="engineering-queue-button" type="button" data-engineering-select="${escapeHTML(identifier)}">
            <div class="ai-room-list-item-top">
              <strong class="ai-room-list-item-title">${escapeHTML(item.title || item.publicId || "Engineering item")}</strong>
              <span class="${getToneClass(item.tone)}">${escapeHTML(item.engineeringStatus || "Needs Diagnosis")}</span>
            </div>
            <div class="engineering-urgency-row">
              <span class="${getUrgencyClass(urgency.visualLevel)}">${escapeHTML(`${urgency.severity || "Low"} severity`)}</span>
              <span class="engineering-urgency-chip engineering-urgency-chip--neutral">${escapeHTML(urgency.affectedUsersLabel || "0 affected users")}</span>
              <span class="engineering-urgency-chip engineering-urgency-chip--neutral">${escapeHTML(openForLabel)}</span>
            </div>
            <p>${escapeHTML(item.summary || item.recommendation || "No summary available.")}</p>
            ${
              reportDelta
                ? `<p class="engineering-detail-note engineering-list-signal">${escapeHTML(reportDelta)}</p>`
                : ""
            }
            <div class="knowledge-card-meta">
              ${meta.map((value) => `<span>${escapeHTML(value)}</span>`).join("")}
            </div>
          </button>
        </article>
      `;
    })
    .join("");
}

function renderLinkedSupportTickets(item = {}) {
  const tickets = Array.isArray(item.linkedSupportTickets) ? item.linkedSupportTickets : [];
  if (!tickets.length) {
    return '<p class="engineering-detail-note">No linked support tickets are attached to this engineering item yet.</p>';
  }

  return `
    <div class="engineering-ticket-list">
      ${tickets
        .map(
          (ticket) => `
            <article class="engineering-ticket-card">
              <div class="ai-room-list-item-top">
                <strong class="ai-room-list-item-title">${escapeHTML(ticket.subject || "Support ticket")}</strong>
                <span class="${getToneClass(ticket.urgency === "High" ? "priority" : "active")}">${escapeHTML(ticket.status || "Open")}</span>
              </div>
              <p>${escapeHTML(ticket.latestUserMessage || "No recent user message is attached.")}</p>
              <div class="knowledge-card-meta">
                <span>${escapeHTML(ticket.urgency || "Medium")} urgency</span>
                <span>${escapeHTML(ticket.requesterRole || "Unknown requester")}</span>
                ${ticket.requesterEmail ? `<span>${escapeHTML(ticket.requesterEmail)}</span>` : ""}
              </div>
              <div class="engineering-action-row">
                <button class="btn secondary" type="button" data-engineering-action="open_support_ticket" data-ticket-id="${escapeHTML(ticket.id || "")}">Open Support Ops</button>
              </div>
            </article>
          `
        )
        .join("")}
    </div>
  `;
}

function renderLatestSupportReport(item = {}) {
  const report = item.latestSupportReport || null;
  if (!report) {
    return '<p class="engineering-detail-note">No support-linked user report is attached yet.</p>';
  }

  return `
    <article class="engineering-ticket-card engineering-ticket-card--latest">
      <div class="ai-room-list-item-top">
        <strong class="ai-room-list-item-title">${escapeHTML(report.subject || "Latest support report")}</strong>
        <span class="${getToneClass(report.urgency === "High" ? "priority" : "active")}">${escapeHTML(report.status || "Open")}</span>
      </div>
      <p>${escapeHTML(report.latestUserMessage || "No recent user message is attached.")}</p>
      <div class="knowledge-card-meta">
        <span>${escapeHTML(report.requesterRole || "Unknown requester")}</span>
        ${
          item.lastReportedAt
            ? `<span>Last reported ${escapeHTML(formatDateTime(item.lastReportedAt))}</span>`
            : ""
        }
        ${
          item.linkedSupportCount
            ? `<span>${escapeHTML(String(item.linkedSupportCount))} ${item.linkedSupportCount === 1 ? "support report" : "support reports"}</span>`
            : ""
        }
        ${report.requesterEmail ? `<span>${escapeHTML(report.requesterEmail)}</span>` : ""}
      </div>
      <div class="engineering-action-row">
        <button class="btn secondary" type="button" data-engineering-action="open_support_ticket" data-ticket-id="${escapeHTML(report.id || "")}">Open Support Ops</button>
      </div>
    </article>
  `;
}

function renderDiagnosisBlock(item = {}) {
  const run = item.latestCtoRun;
  if (!run) {
    return `
      <div class="ai-room-focus-block">
        <h3>CTO Diagnosis</h3>
        <p>No diagnosis summary is attached yet. The incident may still have investigation context, but no saved diagnosis is available here.</p>
      </div>
    `;
  }

  return `
    <div class="ai-room-focus-block">
      <h3>CTO Diagnosis</h3>
      <p>${escapeHTML(run.diagnosisSummary || "Diagnosis packet generated.")}</p>
      <div class="engineering-detail-meta-grid engineering-detail-meta-grid--two-up">
        ${renderMetaItem("Category", run.category || "Unknown")}
        ${renderMetaItem("Urgency", run.urgency || "Medium")}
        ${renderMetaItem("Technical Severity", run.technicalSeverity || "Medium")}
        ${renderMetaItem("Generated", formatDateTime(run.generatedAt))}
      </div>
      ${
        run.autoDiagnosis
          ? `<p class="engineering-detail-note">Started automatically from support escalation. This means CTO analysis has started, not that a fix has been approved or deployed.</p>`
          : run.triggerLabel
          ? `<p class="engineering-detail-note">${escapeHTML(run.triggerLabel)}.</p>`
          : ""
      }
      ${run.recommendedFixStrategy ? `<p class="engineering-detail-note">${escapeHTML(run.recommendedFixStrategy)}</p>` : ""}
      <p class="engineering-detail-note">Likely files to inspect</p>
      ${renderList(run.filesToInspect, "No mapped files are attached yet.")}
      <p class="engineering-detail-note">Targeted test plan</p>
      ${renderList(run.testPlan, "No targeted test plan is attached yet.")}
    </div>
  `;
}

function renderExecutionBlock(item = {}) {
  const run = item.latestExecutionRun;
  if (!run) {
    return `
      <div class="ai-room-focus-block">
        <h3>CTO Execution</h3>
        <p>No execution plan has been prepared yet. Manual review still applies even after a plan exists.</p>
      </div>
    `;
  }

  const readiness = run.deploymentReadiness || {};
  return `
    <div class="ai-room-focus-block">
      <h3>CTO Execution</h3>
      <p>${escapeHTML(run.implementationSummary || "Execution packet generated.")}</p>
      <div class="engineering-detail-meta-grid engineering-detail-meta-grid--two-up">
        ${renderMetaItem("Execution Status", run.executionStatus || "Awaiting Approval")}
        ${renderMetaItem("Generated", formatDateTime(run.generatedAt))}
        ${renderMetaItem("Readiness", readiness.status || "Not ready")}
        ${renderMetaItem("Blockers", Array.isArray(readiness.blockers) ? String(readiness.blockers.length) : "0")}
      </div>
      <p class="engineering-detail-note">Execution plan</p>
      ${renderList(run.executionPlan, "No execution steps are attached yet.")}
      <p class="engineering-detail-note">Required tests</p>
      ${renderList(run.requiredTests, "No required tests are attached yet.")}
      ${readiness.reviewerNotes ? `<p class="engineering-detail-note">${escapeHTML(readiness.reviewerNotes)}</p>` : ""}
    </div>
  `;
}

function renderRecommendedAction(item = {}) {
  const recommendedAction = item.recommendedNextAction || null;
  const resolveAction = item.resolveAction || null;
  if (!recommendedAction && !resolveAction) return "";

  const supplementalResolve =
    resolveAction && recommendedAction?.actionType !== "mark_resolved"
      ? renderActionButton(resolveAction)
      : "";

  return `
    <section class="ai-room-focus-block engineering-recommended-action">
      <p class="knowledge-detail-kicker">Recommended Next Action</p>
      <h3>${escapeHTML(recommendedAction?.label || resolveAction?.label || "Review Incident")}</h3>
      <p class="knowledge-detail-summary">${escapeHTML(
        recommendedAction?.description ||
          resolveAction?.description ||
          "Review the latest CTO and support context before taking the next step."
      )}</p>
      <div class="engineering-action-row engineering-action-row--recommended">
        ${recommendedAction ? renderActionButton(recommendedAction) : ""}
        ${supplementalResolve}
      </div>
    </section>
  `;
}

function renderDetail(item) {
  const root = document.getElementById("engineeringDetail");
  if (!root) return;

  if (state.detailLoading) {
    root.innerHTML = '<div class="ai-room-empty">Loading engineering item detail...</div>';
    return;
  }

  if (!item) {
    root.innerHTML = '<div class="ai-room-empty">Select an engineering item to inspect its incident, support, and CTO context.</div>';
    return;
  }

  const sourceContext = item.sourceContext || {};
  const incident = item.incident || {};
  const recommendedAction = item.recommendedNextAction || null;
  const actions = [item.primaryAction, item.secondaryAction]
    .filter(Boolean)
    .filter((action) => {
      if (!recommendedAction) return true;
      return !(
        action.actionType === recommendedAction.actionType &&
        String(action.incidentId || action.ticketId || action.href || "") ===
          String(recommendedAction.incidentId || recommendedAction.ticketId || recommendedAction.href || "")
      );
    });
  const openForLabel = item.createdAt ? formatDuration(item.createdAt) : "Unknown";

  root.innerHTML = `
    <div class="engineering-detail">
      <section class="ai-room-focus-block engineering-detail-hero">
        <div class="engineering-detail-top">
          <div>
            <p class="knowledge-detail-kicker">Engineering Item ${escapeHTML(item.publicId || "")}</p>
            <h3>${escapeHTML(item.title || "Engineering item")}</h3>
          </div>
          <span class="${getToneClass(item.tone)}">${escapeHTML(item.engineeringStatus || "Needs Diagnosis")}</span>
        </div>
        <p class="knowledge-detail-summary">${escapeHTML(item.summary || item.recommendation || "No summary is available yet.")}</p>
        <p class="engineering-detail-note">${escapeHTML(item.recommendation || "Review incident, support, and CTO context before taking the next manual step.")}</p>
        <div class="engineering-action-row">
          ${actions.map((action) => renderActionButton(action)).join("")}
          <button class="btn secondary" type="button" data-engineering-action="refresh_workspace">Refresh</button>
        </div>
      </section>

      ${renderRecommendedAction(item)}

      <section class="ai-room-focus-block">
        <h3>Current Context</h3>
        <div class="engineering-detail-meta-grid">
          ${renderMetaItem("Severity", item.urgency?.severity || item.risk?.severity || "Low")}
          ${renderMetaItem("Risk", `${item.risk?.level || "Low"} / ${item.risk?.severity || "Low"}`)}
          ${renderMetaItem("Domain", item.risk?.domain || "Unknown")}
          ${renderMetaItem("Incident State", incident.state || "Unknown")}
          ${renderMetaItem("Approval State", incident.approvalState || "Unknown")}
          ${renderMetaItem("Affected Users", item.urgency?.affectedUsersLabel || "0 affected users")}
          ${renderMetaItem("Open For", openForLabel)}
          ${renderMetaItem("Source", item.sourceContextLabel || "Incident-linked")}
          ${renderMetaItem("Updated", formatDateTime(item.updatedAt))}
          ${renderMetaItem("Support Reports", item.linkedSupportCount ? String(item.linkedSupportCount) : "0")}
          ${renderMetaItem("Last Reported", formatDateTime(item.lastReportedAt))}
        </div>
      </section>

      <section class="ai-room-focus-block">
        <h3>Source Issue / Incident Context</h3>
        <div class="engineering-detail-meta-grid">
          ${renderMetaItem("Surface", sourceContext.surface || "Unknown")}
          ${renderMetaItem("Feature", sourceContext.featureKey || "Unknown")}
          ${renderMetaItem("Route", sourceContext.routePath || "Unknown")}
          ${renderMetaItem("Reporter", sourceContext.reporterRole || "Unknown")}
          ${renderMetaItem("Case", sourceContext.caseId || "-")}
          ${renderMetaItem("Job", sourceContext.jobId || "-")}
        </div>
        <div class="engineering-action-row">
          <button class="btn secondary" type="button" data-engineering-action="open_incident_workspace" data-incident-id="${escapeHTML(getItemIdentifier(item))}">Open Incident Workspace</button>
          ${
            sourceContext.pageUrl
              ? `<button class="btn secondary" type="button" data-engineering-action="open_source_page" data-href="${escapeHTML(sourceContext.pageUrl)}">Open Source Page</button>`
              : ""
          }
        </div>
      </section>

      <section class="ai-room-focus-block">
        <h3>Latest Support-Chat Report</h3>
        ${renderLatestSupportReport(item)}
      </section>

      <section class="ai-room-focus-block">
        <h3>Linked Support Context</h3>
        ${renderLinkedSupportTickets(item)}
      </section>

      ${renderDiagnosisBlock(item)}
      ${renderExecutionBlock(item)}
    </div>
  `;
}

async function fetchEngineeringOverview() {
  const res = await secureFetch("/api/admin/engineering/overview", {
    headers: { Accept: "application/json" },
  });
  const payload = await readJsonOrThrow(res, "Unable to load engineering overview.");
  return payload.overview || null;
}

async function fetchEngineeringItems() {
  const res = await secureFetch("/api/admin/engineering/items?limit=24", {
    headers: { Accept: "application/json" },
  });
  const payload = await readJsonOrThrow(res, "Unable to load engineering queue.");
  return Array.isArray(payload.items) ? payload.items : [];
}

async function fetchEngineeringItemDetail(identifier) {
  const res = await secureFetch(`/api/admin/engineering/items/${encodeURIComponent(identifier)}`, {
    headers: { Accept: "application/json" },
  });
  const payload = await readJsonOrThrow(res, "Unable to load engineering item detail.");
  return payload.item || null;
}

async function selectEngineeringItem(identifier, force = false) {
  const nextId = String(identifier || "").trim();
  if (!nextId) {
    state.activeItemId = "";
    state.detail = null;
    renderQueue(state.items);
    renderDetail(null);
    return;
  }

  if (!force && state.activeItemId === nextId && state.detail) {
    renderQueue(state.items);
    renderDetail(state.detail);
    return;
  }

  state.activeItemId = nextId;
  state.detailLoading = true;
  renderQueue(state.items);
  renderDetail(null);

  try {
    state.detail = await fetchEngineeringItemDetail(nextId);
    state.detailLoading = false;
    renderDetail(state.detail);
  } catch (error) {
    state.detailLoading = false;
    state.detail = null;
    renderDetail(null);
    setWorkspaceStatus(error?.message || "Unable to load engineering item detail.", "error");
  }
}

async function loadEngineeringWorkspace(force = false, preferredItemId = "") {
  if (state.listLoading && !force) return;
  state.listLoading = true;
  setWorkspaceStatus("Loading engineering...");
  renderOverview(state.overview);

  try {
    const [overview, items] = await Promise.all([fetchEngineeringOverview(), fetchEngineeringItems()]);
    state.overview = overview;
    state.items = items;
    renderOverview(overview);
    renderQuickActions(overview?.quickActions || []);
    renderQueue(items);
    const visibleItems = getVisibleQueueItems(items);

    const nextId = visibleItems.some((item) => getItemIdentifier(item) === preferredItemId)
      ? preferredItemId
      : visibleItems.some((item) => getItemIdentifier(item) === state.activeItemId)
        ? state.activeItemId
        : getItemIdentifier(visibleItems[0]);

    await selectEngineeringItem(nextId, true);
    setWorkspaceStatus(
      visibleItems.length
        ? `${visibleItems.length} engineering item${visibleItems.length === 1 ? "" : "s"} loaded.`
        : "Engineering queue is empty."
    );
  } catch (error) {
    state.items = [];
    state.detail = null;
    renderOverview(state.overview);
    renderQuickActions([]);
    renderQueue([]);
    renderDetail(null);
    setWorkspaceStatus(error?.message || "Unable to load engineering workspace.", "error");
  } finally {
    state.listLoading = false;
    renderOverview(state.overview);
  }
}

async function runEngineeringMutation(identifier, actionPath, successMessage, options = {}) {
  const res = await secureFetch(`/api/admin/engineering/items/${encodeURIComponent(identifier)}/${actionPath}`, {
    method: "POST",
    headers: { Accept: "application/json" },
    body: {},
  });
  const payload = await readJsonOrThrow(res, `Unable to ${actionPath.replace(/-/g, " ")}.`);
  if (options.archiveResolvedId) state.archivedResolvedIds.add(options.archiveResolvedId);
  await loadEngineeringWorkspace(true, options.preferredItemId || identifier);
  setWorkspaceStatus(successMessage, options.tone || "muted");
  return payload;
}

async function handleAction(button) {
  const actionType = button.getAttribute("data-engineering-action") || "";
  const incidentId = button.getAttribute("data-incident-id") || "";
  const ticketId = button.getAttribute("data-ticket-id") || "";
  const href = button.getAttribute("data-href") || "";
  const actionKey = `${actionType}:${incidentId || ticketId || href}`;

  try {
    state.pendingActionKey = actionKey;
    renderQuickActions(state.overview?.quickActions || []);
    renderDetail(state.detail);

    if (actionType === "refresh_workspace") {
      await loadEngineeringWorkspace(true, state.activeItemId);
      return;
    }
    if (actionType === "run_diagnosis") {
      await runEngineeringMutation(
        incidentId,
        "diagnose",
        "Diagnosis summary prepared. Manual review still applies before execution."
      );
      return;
    }
    if (actionType === "build_execution") {
      await runEngineeringMutation(
        incidentId,
        "execution",
        "Execution plan prepared. This does not approve deployment."
      );
      return;
    }
    if (actionType === "copy_prompt") {
      const prompt =
        state.detail?.latestExecutionRun?.codexExecutionPrompt || state.detail?.latestCtoRun?.codexPatchPrompt || "";
      await copyTextToClipboard(prompt);
      setWorkspaceStatus("Engineering prompt copied.", "success");
      return;
    }
    if (actionType === "mark_resolved") {
      const nextVisibleItem = getVisibleQueueItems(state.items).find(
        (item) => getItemIdentifier(item) && getItemIdentifier(item) !== incidentId
      );
      await runEngineeringMutation(
        incidentId,
        "resolve",
        "Resolved - user has been notified in their support chat.",
        {
          tone: "success",
          preferredItemId: getItemIdentifier(nextVisibleItem),
          archiveResolvedId: incidentId,
        }
      );
      return;
    }
    if (actionType === "open_incident_workspace") {
      await window.openIncidentInAdminRoom?.(incidentId);
      return;
    }
    if (actionType === "open_support_ticket") {
      await window.openSupportTicketInAdmin?.(ticketId);
      return;
    }
    if (actionType === "open_source_page" && href) {
      window.open(href, "_blank", "noopener");
    }
  } catch (error) {
    setWorkspaceStatus(error?.message || "Unable to complete the engineering action.", "error");
  } finally {
    state.pendingActionKey = "";
    renderQuickActions(state.overview?.quickActions || []);
    renderDetail(state.detail);
  }
}

function bindEngineeringWorkspace() {
  const section = document.getElementById("section-engineering");
  if (!section || section.dataset.boundEngineering === "true") return;
  section.dataset.boundEngineering = "true";

  section.addEventListener("click", (event) => {
    const selectButton = event.target.closest("[data-engineering-select]");
    if (selectButton) {
      const identifier = selectButton.getAttribute("data-engineering-select") || "";
      selectEngineeringItem(identifier, true).catch(() => {});
      return;
    }

    const actionButton = event.target.closest("[data-engineering-action]");
    if (actionButton) {
      handleAction(actionButton).catch(() => {});
    }
  });

  const observer = new MutationObserver(() => {
    if (section.classList.contains("visible")) {
      loadEngineeringWorkspace().catch(() => {});
    }
  });
  observer.observe(section, {
    attributes: true,
    attributeFilter: ["class"],
  });
}

bindEngineeringWorkspace();
window.loadEngineeringWorkspace = loadEngineeringWorkspace;
window.openEngineeringItemInAdmin = async (incidentId) => {
  window.activateAdminSection?.("engineering");
  await loadEngineeringWorkspace(true, String(incidentId || "").trim());
};

if (document.getElementById("section-engineering")?.classList.contains("visible")) {
  loadEngineeringWorkspace().catch(() => {});
}
