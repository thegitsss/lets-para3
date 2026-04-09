import { secureFetch } from "../auth.js";

const FILTERABLE_STATUSES = ["open", "in_review", "waiting_on_user", "resolved", "all"];
const DEFAULT_STATUS_FILTER = "open";
const DEFAULT_SORT = "newest";

const state = {
  activeTicketId: "",
  tickets: [],
  filters: {
    status: DEFAULT_STATUS_FILTER,
    urgency: "all",
    role: "all",
    dateRange: "all",
    sort: DEFAULT_SORT,
  },
  detailLoading: false,
  listLoading: false,
};

function escapeHTML(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatDate(value, { relative = false } = {}) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  if (!relative) return date.toLocaleString();

  const deltaMs = Date.now() - date.getTime();
  const deltaMinutes = Math.round(deltaMs / 60000);
  if (deltaMinutes < 1) return "Just now";
  if (deltaMinutes < 60) return `${deltaMinutes}m ago`;
  if (deltaMinutes < 1440) return `${Math.round(deltaMinutes / 60)}h ago`;
  if (deltaMinutes < 10080) return `${Math.round(deltaMinutes / 1440)}d ago`;
  return date.toLocaleDateString();
}

function titleize(value = "") {
  const text = String(value || "").replace(/_/g, " ").trim();
  if (!text) return "—";
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function readJson(res) {
  return res.json().catch(() => ({}));
}

async function readJsonOrThrow(res, fallbackMessage) {
  const payload = await readJson(res);
  if (!res.ok) throw new Error(payload?.error || fallbackMessage);
  return payload;
}

function statusLabel(status = "") {
  const normalized = String(status || "").trim().toLowerCase();
  if (normalized === "waiting_on_info") return "Waiting on User";
  return titleize(normalized || "open");
}

function badgeToneForStatus(status = "") {
  const normalized = String(status || "").trim().toLowerCase();
  if (normalized === "resolved" || normalized === "closed") return "healthy";
  if (normalized === "waiting_on_user" || normalized === "waiting_on_info") return "priority";
  if (normalized === "in_review") return "needs-review";
  return "active";
}

function badgeToneForUrgency(urgency = "") {
  const normalized = String(urgency || "").trim().toLowerCase();
  if (normalized === "high") return "priority";
  if (normalized === "low") return "healthy";
  return "active";
}

function supportMessageVariant(message = {}) {
  if (message.sender === "user") return "user";
  if (message.metadata?.kind === "team_reply") return "team";
  if (message.metadata?.kind === "support_escalation") return "notice";
  if (message.sender === "system") return "notice";
  return "assistant";
}

function supportMessageLabel(message = {}) {
  const variant = supportMessageVariant(message);
  if (variant === "user") return "User";
  if (variant === "team") return message.metadata?.teamLabel || message.metadata?.adminName || "LPC Team";
  if (variant === "notice") return "System";
  return "Assistant";
}

function buildDateFromFilter(value = "") {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "7") {
    return new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  }
  if (normalized === "30") {
    return new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  }
  return "";
}

function buildTicketListQuery() {
  const params = new URLSearchParams();
  const { status, urgency, role, dateRange, sort } = state.filters;
  if (status && status !== "all") params.set("status", status);
  if (urgency && urgency !== "all") params.set("urgency", urgency);
  if (role && role !== "all") params.set("role", role);
  if (sort && sort !== DEFAULT_SORT) params.set("sort", sort);
  const dateFrom = buildDateFromFilter(dateRange);
  if (dateFrom) params.set("dateFrom", dateFrom);
  return params.toString();
}

function setStatusMessage(message = "", type = "muted") {
  const root = document.getElementById("supportOpsStatus");
  if (!root) return;
  root.textContent = message;
  root.dataset.tone = type;
}

function renderCounts(overview = {}) {
  const counts = overview.counts || {};
  const mappings = [
    ["supportOpenCount", counts.open || 0],
    ["supportBlockerCount", counts.blockers || 0],
    ["supportWaitingCount", counts.waitingOnUser || 0],
    ["supportResolvedCount", counts.resolved || 0],
  ];
  mappings.forEach(([id, value]) => {
    const el = document.getElementById(id);
    if (el) el.textContent = String(value);
  });
}

function renderFilterState() {
  document.querySelectorAll("[data-support-filter-status]").forEach((button) => {
    const active = button.getAttribute("data-support-filter-status") === state.filters.status;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-pressed", active ? "true" : "false");
  });
  const urgency = document.getElementById("supportUrgencyFilter");
  const role = document.getElementById("supportRoleFilter");
  const dateRange = document.getElementById("supportDateFilter");
  const sort = document.getElementById("supportSortFilter");
  if (urgency) urgency.value = state.filters.urgency;
  if (role) role.value = state.filters.role;
  if (dateRange) dateRange.value = state.filters.dateRange;
  if (sort) sort.value = state.filters.sort;
}

function renderTicketList(tickets = []) {
  state.tickets = Array.isArray(tickets) ? tickets.slice() : [];
  const root = document.getElementById("supportTicketList");
  if (!root) return;

  if (!tickets.length) {
    root.innerHTML = `
      <div class="ai-room-empty">
        No tickets match the current filters. Escalated support conversations will appear here automatically.
      </div>
    `;
    return;
  }

  root.innerHTML = tickets
    .map((ticket) => {
      const active = String(ticket.id || ticket._id) === state.activeTicketId;
      const requester = ticket.requester || {};
      return `
        <article
          class="ai-room-list-item support-list-card${active ? " support-list-card--active" : ""}"
          data-support-ticket-id="${escapeHTML(ticket.id || ticket._id || "")}"
          role="button"
          tabindex="0"
          aria-pressed="${active ? "true" : "false"}"
        >
          <div class="ai-room-list-item-top">
            <div>
              <p class="support-ticket-ref">${escapeHTML(ticket.reference || "")}</p>
              <strong class="ai-room-list-item-title">${escapeHTML(ticket.subject || "Support ticket")}</strong>
            </div>
            <div class="support-ticket-row-badges">
              <span class="ai-room-badge ai-room-badge--${badgeToneForUrgency(ticket.urgency)}">${escapeHTML(
                titleize(ticket.urgency || "medium")
              )}</span>
              <span class="ai-room-badge ai-room-badge--${badgeToneForStatus(ticket.status)}">${escapeHTML(
                statusLabel(ticket.status)
              )}</span>
            </div>
          </div>
          <p>${escapeHTML(ticket.issuePreview || ticket.latestIssuePreview || "No issue preview available.")}</p>
          <div class="support-ticket-list-meta">
            <span>${escapeHTML(requester.name || "Unknown user")}</span>
            <span>${escapeHTML(requester.email || ticket.requesterEmail || "—")}</span>
            <span>${escapeHTML(titleize(requester.role || ticket.requesterRole || "unknown"))}</span>
            <span>${escapeHTML(titleize(ticket.classification?.category || "general_support"))}</span>
            <span>${escapeHTML(formatDate(ticket.createdAt, { relative: true }))}</span>
          </div>
        </article>
      `;
    })
    .join("");
}

function renderFaqCandidates(candidates = []) {
  const root = document.getElementById("supportFaqCandidateList");
  if (!root) return;
  if (!candidates.length) {
    root.innerHTML = `<div class="ai-room-empty">No FAQ candidates are pending review.</div>`;
    return;
  }
  root.innerHTML = candidates
    .map(
      (candidate) => `
        <article class="ai-room-list-item">
          <div class="ai-room-list-item-top">
            <strong class="ai-room-list-item-title">${escapeHTML(candidate.title || "FAQ candidate")}</strong>
            <span class="ai-room-badge ai-room-badge--needs-review">${escapeHTML(
              titleize(candidate.approvalState || "pending_review")
            )}</span>
          </div>
          <p>${escapeHTML(candidate.question || "")}</p>
          <p class="small">${escapeHTML(titleize(candidate.category || "support"))} · ${escapeHTML(
            `${candidate.repeatCount || 0} repeats`
          )}</p>
          <div class="support-admin-actions">
            <button class="btn secondary" type="button" data-support-open-approvals="faq_candidate:${escapeHTML(
              String(candidate.id || candidate._id || "")
            )}">Open In Approvals</button>
          </div>
        </article>
      `
    )
    .join("");
}

function renderInsights(insights = []) {
  const root = document.getElementById("supportInsightList");
  if (!root) return;
  if (!insights.length) {
    root.innerHTML = `<div class="ai-room-empty">No support insights are visible yet.</div>`;
    return;
  }
  root.innerHTML = insights
    .map(
      (insight) => `
        <article class="ai-room-list-item">
          <div class="ai-room-list-item-top">
            <strong class="ai-room-list-item-title">${escapeHTML(insight.title || "Support insight")}</strong>
            <span class="ai-room-badge ai-room-badge--${
              insight.priority === "needs_review" ? "needs-review" : "active"
            }">${escapeHTML(titleize(insight.priority || "watch"))}</span>
          </div>
          <p>${escapeHTML(insight.summary || "")}</p>
          <p class="small">${escapeHTML(titleize(insight.insightType || "signal"))} · ${escapeHTML(
            `${insight.repeatCount || 0} related tickets`
          )}</p>
        </article>
      `
    )
    .join("");
}

function formatFactValue(value) {
  if (value === null || typeof value === "undefined" || value === "") return "—";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (Array.isArray(value)) {
    const normalized = value.map((item) => String(item || "").trim()).filter(Boolean);
    return normalized.length ? normalized.join(", ") : "—";
  }
  if (typeof value === "object") return escapeHTML(JSON.stringify(value, null, 2));
  return escapeHTML(String(value));
}

function renderFactRows(record = {}) {
  const entries = Object.entries(record || {}).filter(([, value]) => {
    if (value === null || typeof value === "undefined") return false;
    if (typeof value === "string") return value.trim().length > 0;
    if (Array.isArray(value)) return value.length > 0;
    if (typeof value === "object") return Object.keys(value).length > 0;
    return true;
  });

  if (!entries.length) {
    return `<p class="small">No grounded facts were captured for this section.</p>`;
  }

  return `
    <div class="support-fact-rows">
      ${entries
        .map(
          ([key, value]) => `
            <div class="support-fact-row">
              <span class="support-fact-key">${escapeHTML(titleize(key))}</span>
              <span class="support-fact-value">${formatFactValue(value)}</span>
            </div>
          `
        )
        .join("")}
    </div>
  `;
}

function renderSupportFactsSnapshot(facts = {}) {
  const sections = [
    ["stripeState", "Stripe"],
    ["payoutState", "Payout"],
    ["caseState", "Case"],
    ["workspaceState", "Workspace"],
    ["messagingState", "Messaging"],
  ];
  const cards = sections
    .filter(([key]) => facts[key] && Object.keys(facts[key] || {}).length)
    .map(
      ([key, label]) => `
        <article class="support-fact-card">
          <h4>${escapeHTML(label)}</h4>
          ${renderFactRows(facts[key])}
        </article>
      `
    );

  if (Array.isArray(facts.blockers) && facts.blockers.length) {
    cards.push(`
      <article class="support-fact-card">
        <h4>Blockers</h4>
        <p>${escapeHTML(facts.blockers.join(", "))}</p>
      </article>
    `);
  }
  if (Array.isArray(facts.nextSteps) && facts.nextSteps.length) {
    cards.push(`
      <article class="support-fact-card">
        <h4>Next Steps</h4>
        <ol class="support-fact-list">
          ${facts.nextSteps.map((step) => `<li>${escapeHTML(step)}</li>`).join("")}
        </ol>
      </article>
    `);
  }

  if (!cards.length) {
    return `<div class="ai-room-empty">No structured support facts were saved on this escalation yet.</div>`;
  }

  return `<div class="support-facts-grid">${cards.join("")}</div>`;
}

function renderPageContext(context = {}) {
  const rows = Object.entries(context || {}).filter(([, value]) => String(value || "").trim());
  if (!rows.length) {
    return `<p class="small">No source page context was captured.</p>`;
  }
  return `
    <div class="support-fact-rows">
      ${rows
        .map(
          ([key, value]) => `
            <div class="support-fact-row">
              <span class="support-fact-key">${escapeHTML(titleize(key))}</span>
              <span class="support-fact-value">${escapeHTML(String(value))}</span>
            </div>
          `
        )
        .join("")}
    </div>
  `;
}

function renderConversationThread(messages = []) {
  if (!messages.length) {
    return `<div class="ai-room-empty">No conversation history is available yet.</div>`;
  }

  return `
    <div class="support-ticket-thread">
      ${messages
        .map((message) => {
          const variant = supportMessageVariant(message);
          return `
            <article class="support-ticket-thread-item support-ticket-thread-item--${variant}">
              <div class="support-ticket-thread-meta">
                <span>${escapeHTML(supportMessageLabel(message))}</span>
                <span>${escapeHTML(formatDate(message.createdAt))}</span>
              </div>
              <div class="support-ticket-thread-bubble">${escapeHTML(message.text || "")}</div>
            </article>
          `;
        })
        .join("")}
    </div>
  `;
}

function renderLinkedIncidents(ticket = {}) {
  const incidents = Array.isArray(ticket.linkedIncidents) ? ticket.linkedIncidents.filter(Boolean) : [];
  if (!incidents.length) {
    return `<p class="small">This ticket is still support-owned.</p>`;
  }

  return `
    <div class="support-note-list">
      ${incidents
        .map(
          (incident) => `
            <article class="support-note-card">
              <div class="support-note-meta">
                <span>${escapeHTML(incident.publicId || incident.id || "Incident")}</span>
                <span>${escapeHTML(titleize(incident.state || "open"))}</span>
              </div>
              <p>${escapeHTML(incident.summary || "Engineering-linked incident.")}</p>
              <div class="support-admin-actions">
                <button class="btn secondary" type="button" data-support-open-incident="${escapeHTML(
                  incident.publicId || incident.id || ""
                )}">Open Engineering Context</button>
              </div>
            </article>
          `
        )
        .join("")}
    </div>
  `;
}

function renderInternalNotes(notes = []) {
  if (!notes.length) {
    return `<div class="ai-room-empty">No internal notes yet.</div>`;
  }
  return `
    <div class="support-note-list">
      ${notes
        .map(
          (note) => `
            <article class="support-note-card">
              <div class="support-note-meta">
                <span>${escapeHTML(note.adminName || "Admin")}</span>
                <span>${escapeHTML(formatDate(note.createdAt))}</span>
              </div>
              <p>${escapeHTML(note.text || "")}</p>
            </article>
          `
        )
        .join("")}
    </div>
  `;
}

function buildReplyAssistDrafts(ticket = {}) {
  const drafts = [];
  const recommendedReply = String(ticket.latestResponsePacket?.recommendedReply || "").trim();
  const ticketStatus = String(ticket.status || "").trim().toLowerCase();
  if (recommendedReply) {
    drafts.push({
      label: "Use suggested reply",
      text: recommendedReply,
    });
  }

  if (ticketStatus === "waiting_on_user" || ticketStatus === "waiting_on_info") {
    drafts.push({
      label: "Need one detail",
      text: "Thanks for the follow-up. I’m reviewing this now. If you can share one more detail here, I’ll keep moving on it.",
    });
  } else if (ticketStatus === "resolved" || ticketStatus === "closed") {
    drafts.push({
      label: "Confirm resolved",
      text: "This should now be resolved. If anything still looks off, reply here and we’ll take another look.",
    });
  } else {
    drafts.push({
      label: "Reviewing now",
      text: "Thanks for the follow-up. I’m reviewing this now and will update you here shortly.",
    });
  }

  const supportFacts = ticket.latestSupportFactsSnapshot || ticket.supportFactsSnapshot || {};
  const category = String(ticket.classification?.category || "").trim().toLowerCase();
  if (
    !supportFacts.caseState?.caseId &&
    ["case_workflow", "messaging", "case_posting"].includes(category)
  ) {
    drafts.push({
      label: "Ask which case",
      text: "Thanks — can you tell me which case this is for so I can review the right workspace?",
    });
  } else if (supportFacts.stripeState?.accountId) {
    drafts.push({
      label: "Stripe follow-up",
      text: "Thanks — I’m reviewing the payout setup on this account and will update you here shortly.",
    });
  }

  return drafts.slice(0, 3);
}

function renderReplyAssist(ticket = {}) {
  const drafts = buildReplyAssistDrafts(ticket);
  if (!drafts.length) return "";
  return `
    <div class="support-reply-assist">
      <p class="support-admin-label">Draft replies</p>
      <div class="support-reply-assist-list">
        ${drafts
          .map(
            (draft, index) => `
              <button
                class="support-reply-assist-button"
                type="button"
                data-support-draft-index="${index}"
                data-support-draft-text="${escapeHTML(draft.text)}"
              >${escapeHTML(draft.label)}</button>
            `
          )
          .join("")}
      </div>
    </div>
  `;
}

function renderTicketDetail(ticket = null) {
  const root = document.getElementById("supportTicketDetail");
  if (!root) return;

  if (!ticket) {
    root.innerHTML = `<div class="ai-room-empty">Select a ticket to review the issue, see the context, add notes, and reply.</div>`;
    return;
  }

  const requester = ticket.requester || {};
  const ticketStatus = ticket.status || "open";
  const replyStatusDefault =
    ticketStatus === "resolved" || ticketStatus === "closed" ? ticketStatus : "waiting_on_user";

  root.innerHTML = `
    <section class="support-ticket-hero">
      <div class="support-ticket-hero-copy">
        <p class="support-ticket-ref">${escapeHTML(ticket.reference || "")}</p>
        <h3>${escapeHTML(ticket.subject || "Support ticket")}</h3>
        <p class="support-ticket-summary">${escapeHTML(
          ticket.latestIssuePreview || ticket.issuePreview || ticket.latestUserMessage || ticket.message || "No issue summary available."
        )}</p>
      </div>
      <div class="support-ticket-badges">
        <span class="ai-room-badge ai-room-badge--${badgeToneForUrgency(ticket.urgency)}">${escapeHTML(
          titleize(ticket.urgency || "medium")
        )}</span>
        <span class="ai-room-badge ai-room-badge--${badgeToneForStatus(ticket.status)}">${escapeHTML(
          statusLabel(ticket.status)
        )}</span>
        <span class="ai-room-badge ai-room-badge--active">${escapeHTML(
          titleize(ticket.classification?.category || "general_support")
        )}</span>
        ${
          ticket.handedOffToEngineering
            ? `<span class="ai-room-badge ai-room-badge--needs-review">Handed Off to Engineering</span>`
            : ""
        }
      </div>
    </section>

    ${
      ticket.handedOffToEngineering
        ? `
          <section class="ai-room-focus-block">
            <h3>Engineering Handoff</h3>
            <p>This issue is already with Engineering. This support view is now reference-only.</p>
            ${renderLinkedIncidents(ticket)}
          </section>
        `
        : ""
    }

    <section class="support-ticket-sticky-actions">
      <div class="support-ticket-action-group">
        <label class="support-inline-field">
          <span>Status</span>
          <select id="supportTicketStatusSelect">
            <option value="open"${ticketStatus === "open" ? " selected" : ""}>Open</option>
            <option value="in_review"${ticketStatus === "in_review" ? " selected" : ""}>In Review</option>
            <option value="waiting_on_user"${
              ticketStatus === "waiting_on_user" || ticketStatus === "waiting_on_info" ? " selected" : ""
            }>Waiting on User</option>
            <option value="resolved"${ticketStatus === "resolved" ? " selected" : ""}>Resolved</option>
            <option value="closed"${ticketStatus === "closed" ? " selected" : ""}>Closed</option>
          </select>
        </label>
        <button class="btn secondary" type="button" id="supportTicketStatusSaveBtn">Update Status</button>
      </div>
      <p class="small">
        Created ${escapeHTML(formatDate(ticket.createdAt))} · Updated ${escapeHTML(
          formatDate(ticket.updatedAt)
        )}${ticket.lastAdminReplyAt ? ` · Last team reply ${escapeHTML(formatDate(ticket.lastAdminReplyAt, { relative: true }))}` : ""}
      </p>
    </section>

    <section class="support-detail-grid">
      <article class="ai-room-focus-block">
        <h3>User Summary</h3>
        ${renderFactRows({
          name: requester.name || "Unknown user",
          email: requester.email || ticket.requesterEmail || "—",
          role: requester.role || ticket.requesterRole || "unknown",
          accountStatus: requester.status || "—",
          assignedTo: ticket.assignedTo?.name || "",
          conversationId: ticket.conversation?.id || ticket.conversationId || "",
        })}
      </article>
      <article class="ai-room-focus-block">
        <h3>Escalation Context</h3>
        ${renderFactRows({
          escalationReason: ticket.escalationReason || "—",
          routePath: ticket.routePath || "—",
          sourceSurface: ticket.sourceSurface || "manual",
          sourceLabel: ticket.sourceLabel || "",
          queueOwner: ticket.routingSuggestion?.ownerKey || "support_ops",
          priority: ticket.routingSuggestion?.priority || "normal",
        })}
      </article>
    </section>

    <section class="ai-room-focus-block">
      <h3>Assistant Summary</h3>
      <p>${escapeHTML(ticket.assistantSummary || "No assistant summary was saved for this escalation.")}</p>
    </section>

    <section class="ai-room-focus-block">
      <h3>Support Facts Snapshot</h3>
      ${renderSupportFactsSnapshot(ticket.latestSupportFactsSnapshot || ticket.supportFactsSnapshot || {})}
    </section>

    <section class="support-detail-grid">
      <article class="ai-room-focus-block">
        <h3>Latest Page Context</h3>
        ${renderPageContext(ticket.latestPageContext || ticket.pageContext || {})}
      </article>
      <article class="ai-room-focus-block">
        <h3>Conversation Metadata</h3>
        ${renderFactRows({
          conversationStatus: ticket.conversation?.status || "—",
          lastMessageAt: ticket.conversation?.lastMessageAt ? formatDate(ticket.conversation.lastMessageAt) : "—",
          escalatedAt: ticket.conversation?.escalation?.requestedAt
            ? formatDate(ticket.conversation.escalation.requestedAt)
            : "—",
          ticketReference: ticket.reference || "",
        })}
      </article>
    </section>

    <section class="ai-room-focus-block">
      <h3>Conversation</h3>
      ${renderConversationThread(ticket.conversationMessages || [])}
    </section>

    <section class="support-detail-grid support-detail-grid--actions">
      <article class="ai-room-focus-block">
        <h3>Internal Notes</h3>
        ${renderInternalNotes(ticket.internalNotes || [])}
        <div class="support-admin-composer">
          <label class="support-admin-label" for="supportTicketNoteInput">Add internal note</label>
          <textarea id="supportTicketNoteInput" rows="4" placeholder="Add internal context for the team."></textarea>
          <div class="support-admin-actions">
            <button class="btn secondary" type="button" id="supportTicketNoteBtn">Save Note</button>
          </div>
        </div>
      </article>
      <article class="ai-room-focus-block">
        <h3>Reply to User</h3>
        <div class="support-admin-composer">
          ${renderReplyAssist(ticket)}
          <label class="support-admin-label" for="supportTicketReplyInput">Team response</label>
          <textarea id="supportTicketReplyInput" rows="6" placeholder="Send a concise grounded update back into the support thread."></textarea>
          <div class="support-admin-actions support-admin-actions--split">
            <label class="support-inline-field">
              <span>After reply</span>
              <select id="supportTicketReplyStatus">
                <option value="waiting_on_user"${replyStatusDefault === "waiting_on_user" ? " selected" : ""}>Waiting on User</option>
                <option value="in_review"${replyStatusDefault === "in_review" ? " selected" : ""}>In Review</option>
                <option value="resolved"${replyStatusDefault === "resolved" ? " selected" : ""}>Resolved</option>
                <option value="closed"${replyStatusDefault === "closed" ? " selected" : ""}>Closed</option>
              </select>
            </label>
            <button class="btn" type="button" id="supportTicketReplyBtn">Send Reply</button>
          </div>
        </div>
      </article>
    </section>
  `;

  bindDetailControls(ticket);
}

async function fetchSupportTicketDetail(ticketId) {
  const res = await secureFetch(`/api/admin/support/tickets/${encodeURIComponent(ticketId)}`, {
    headers: { Accept: "application/json" },
  });
  const payload = await readJsonOrThrow(res, "Unable to load support ticket.");
  return payload.ticket;
}

async function selectTicket(ticketId) {
  if (!ticketId) {
    state.activeTicketId = "";
    renderTicketList(state.tickets);
    renderTicketDetail(null);
    return;
  }

  state.activeTicketId = String(ticketId);
  renderTicketList(state.tickets);
  state.detailLoading = true;
  renderTicketDetail(null);

  try {
    const detail = await fetchSupportTicketDetail(state.activeTicketId);
    renderTicketDetail(detail);
  } catch (error) {
    renderTicketDetail(null);
    setStatusMessage(error?.message || "Unable to load support ticket.", "error");
  } finally {
    state.detailLoading = false;
  }
}

async function loadSupportOps(force = false) {
  if (state.listLoading && !force) return;
  state.listLoading = true;
  renderFilterState();
  setStatusMessage("Loading support tickets…");

  try {
    const ticketQuery = buildTicketListQuery();
    const [overviewRes, ticketsRes, faqRes, insightRes] = await Promise.all([
      secureFetch("/api/admin/support/overview", { headers: { Accept: "application/json" } }),
      secureFetch(`/api/admin/support/tickets${ticketQuery ? `?${ticketQuery}` : ""}`, {
        headers: { Accept: "application/json" },
      }),
      secureFetch("/api/admin/support/faq-candidates?approvalState=pending_review", {
        headers: { Accept: "application/json" },
      }),
      secureFetch("/api/admin/support/insights", { headers: { Accept: "application/json" } }),
    ]);

    const overview = await readJsonOrThrow(overviewRes, "Unable to load support overview.");
    const ticketsPayload = await readJsonOrThrow(ticketsRes, "Unable to load support tickets.");
    const faqPayload = await readJsonOrThrow(faqRes, "Unable to load FAQ candidates.");
    const insightPayload = await readJsonOrThrow(insightRes, "Unable to load support insights.");

    renderCounts(overview);
    renderTicketList(ticketsPayload.tickets || []);
    renderFaqCandidates(faqPayload.candidates || []);
    renderInsights(insightPayload.insights || []);

    const nextTicketId = ticketsPayload.tickets?.some((ticket) => String(ticket.id || ticket._id) === state.activeTicketId)
      ? state.activeTicketId
      : ticketsPayload.tickets?.[0]?.id || ticketsPayload.tickets?.[0]?._id || "";
    await selectTicket(nextTicketId);

    const count = (ticketsPayload.tickets || []).length;
    const handedOffCount = Number(overview?.counts?.handedOffToEngineering || 0);
    const suffix = handedOffCount
      ? ` ${handedOffCount} engineering-linked ticket${handedOffCount === 1 ? " remains" : "s remain"} accessible from Engineering or direct links.`
      : "";
    setStatusMessage(`${count} support-owned ticket${count === 1 ? "" : "s"} loaded.${suffix}`);
  } catch (error) {
    renderTicketList([]);
    renderTicketDetail(null);
    renderFaqCandidates([]);
    renderInsights([]);
    setStatusMessage(error?.message || "Unable to load support operations.", "error");
  } finally {
    state.listLoading = false;
  }
}

async function patchTicketStatus(ticketId, status) {
  const res = await secureFetch(`/api/admin/support/tickets/${encodeURIComponent(ticketId)}/status`, {
    method: "PATCH",
    headers: { Accept: "application/json" },
    body: { status },
  });
  return readJsonOrThrow(res, "Unable to update ticket status.");
}

async function createInternalNote(ticketId, text) {
  const res = await secureFetch(`/api/admin/support/tickets/${encodeURIComponent(ticketId)}/note`, {
    method: "POST",
    headers: { Accept: "application/json" },
    body: { text },
  });
  return readJsonOrThrow(res, "Unable to save internal note.");
}

async function replyToTicket(ticketId, text, status) {
  const res = await secureFetch(`/api/admin/support/tickets/${encodeURIComponent(ticketId)}/reply`, {
    method: "POST",
    headers: { Accept: "application/json" },
    body: { text, status },
  });
  return readJsonOrThrow(res, "Unable to send support reply.");
}

async function generateFaqCandidates() {
  setStatusMessage("Generating FAQ candidates…");
  try {
    const res = await secureFetch("/api/admin/support/faq-candidates/generate", {
      method: "POST",
      headers: { Accept: "application/json" },
      body: {},
    });
    const payload = await readJsonOrThrow(res, "Unable to generate FAQ candidates.");
    setStatusMessage(`${(payload.candidates || []).length} FAQ candidate${(payload.candidates || []).length === 1 ? "" : "s"} refreshed.`);
    await loadSupportOps(true);
  } catch (error) {
    setStatusMessage(error?.message || "Unable to generate FAQ candidates.", "error");
  }
}

async function refreshSupportInsights() {
  setStatusMessage("Refreshing support insights…");
  try {
    const res = await secureFetch("/api/admin/support/insights/refresh", {
      method: "POST",
      headers: { Accept: "application/json" },
      body: {},
    });
    const payload = await readJsonOrThrow(res, "Unable to refresh support insights.");
    setStatusMessage(`${(payload.insights || []).length} support insight${(payload.insights || []).length === 1 ? "" : "s"} refreshed.`);
    await loadSupportOps(true);
  } catch (error) {
    setStatusMessage(error?.message || "Unable to refresh support insights.", "error");
  }
}

function bindDetailControls(ticket) {
  const ticketId = ticket.id || ticket._id;
  const statusButton = document.getElementById("supportTicketStatusSaveBtn");
  const noteButton = document.getElementById("supportTicketNoteBtn");
  const replyButton = document.getElementById("supportTicketReplyBtn");
  const replyInput = document.getElementById("supportTicketReplyInput");

  document.querySelectorAll("[data-support-draft-index]").forEach((button) => {
    if (button.dataset.bound === "true") return;
    button.dataset.bound = "true";
    button.addEventListener("click", () => {
      if (!replyInput) return;
      replyInput.value = button.getAttribute("data-support-draft-text") || "";
      replyInput.focus();
    });
  });

  if (statusButton) {
    statusButton.addEventListener("click", async () => {
      const select = document.getElementById("supportTicketStatusSelect");
      const nextStatus = select?.value || ticket.status || "open";
      statusButton.disabled = true;
      setStatusMessage("Updating ticket status…");
      try {
        await patchTicketStatus(ticketId, nextStatus);
        await loadSupportOps(true);
        setStatusMessage(`Ticket moved to ${statusLabel(nextStatus)}.`);
      } catch (error) {
        setStatusMessage(error?.message || "Unable to update ticket status.", "error");
      } finally {
        statusButton.disabled = false;
      }
    });
  }

  if (noteButton) {
    noteButton.addEventListener("click", async () => {
      const input = document.getElementById("supportTicketNoteInput");
      const text = input?.value?.trim() || "";
      if (!text) {
        setStatusMessage("Add a note before saving.", "error");
        return;
      }
      noteButton.disabled = true;
      setStatusMessage("Saving internal note…");
      try {
        await createInternalNote(ticketId, text);
        await loadSupportOps(true);
        setStatusMessage("Internal note saved.");
      } catch (error) {
        setStatusMessage(error?.message || "Unable to save internal note.", "error");
      } finally {
        noteButton.disabled = false;
      }
    });
  }

  if (replyButton) {
    replyButton.addEventListener("click", async () => {
      const input = document.getElementById("supportTicketReplyInput");
      const status = document.getElementById("supportTicketReplyStatus")?.value || "waiting_on_user";
      const text = input?.value?.trim() || "";
      if (!text) {
        setStatusMessage("Write a reply before sending it to the user.", "error");
        return;
      }
      replyButton.disabled = true;
      setStatusMessage("Sending team reply…");
      try {
        await replyToTicket(ticketId, text, status);
        await loadSupportOps(true);
        setStatusMessage("Team reply sent to the support conversation.");
      } catch (error) {
        setStatusMessage(error?.message || "Unable to send support reply.", "error");
      } finally {
        replyButton.disabled = false;
      }
    });
  }
}

function bindTicketList() {
  const list = document.getElementById("supportTicketList");
  if (!list || list.dataset.bound === "true") return;
  list.dataset.bound = "true";

  const handleSelect = async (target) => {
    const item = target.closest("[data-support-ticket-id]");
    if (!item) return;
    await selectTicket(item.getAttribute("data-support-ticket-id") || "");
  };

  list.addEventListener("click", (event) => {
    handleSelect(event.target).catch(() => {});
  });
  list.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    handleSelect(event.target).catch(() => {});
  });
}

function bindFilters() {
  document.querySelectorAll("[data-support-filter-status]").forEach((button) => {
    if (button.dataset.bound === "true") return;
    button.dataset.bound = "true";
    button.addEventListener("click", async () => {
      const nextStatus = button.getAttribute("data-support-filter-status");
      if (!FILTERABLE_STATUSES.includes(nextStatus)) return;
      state.filters.status = nextStatus;
      await loadSupportOps(true);
    });
  });

  [
    ["supportUrgencyFilter", "urgency"],
    ["supportRoleFilter", "role"],
    ["supportDateFilter", "dateRange"],
    ["supportSortFilter", "sort"],
  ].forEach(([id, key]) => {
    const el = document.getElementById(id);
    if (!el || el.dataset.bound === "true") return;
    el.dataset.bound = "true";
    el.addEventListener("change", async () => {
      state.filters[key] = el.value || "all";
      await loadSupportOps(true);
    });
  });
}

function bindControls() {
  const refreshBtn = document.getElementById("supportRefreshBtn");
  const faqBtn = document.getElementById("supportGenerateFaqBtn");
  const insightBtn = document.getElementById("supportRefreshInsightsBtn");

  if (refreshBtn && refreshBtn.dataset.bound !== "true") {
    refreshBtn.dataset.bound = "true";
    refreshBtn.addEventListener("click", () => {
      loadSupportOps(true).catch(() => {});
    });
  }
  if (faqBtn && faqBtn.dataset.bound !== "true") {
    faqBtn.dataset.bound = "true";
    faqBtn.addEventListener("click", () => {
      generateFaqCandidates().catch(() => {});
    });
  }
  if (insightBtn && insightBtn.dataset.bound !== "true") {
    insightBtn.dataset.bound = "true";
    insightBtn.addEventListener("click", () => {
      refreshSupportInsights().catch(() => {});
    });
  }

  const detail = document.getElementById("supportTicketDetail");
  if (detail && detail.dataset.boundIncident !== "true") {
    detail.dataset.boundIncident = "true";
    detail.addEventListener("click", (event) => {
      const button = event.target.closest("[data-support-open-incident]");
      if (!button) return;
      const incidentId = button.getAttribute("data-support-open-incident") || "";
      window.openIncidentInAdminRoom?.(incidentId);
    });
  }
  const faqList = document.getElementById("supportFaqCandidateList");
  if (faqList && faqList.dataset.boundApprovals !== "true") {
    faqList.dataset.boundApprovals = "true";
    faqList.addEventListener("click", (event) => {
      const button = event.target.closest("[data-support-open-approvals]");
      if (!button) return;
      const workKey = button.getAttribute("data-support-open-approvals") || "";
      window.openApprovalWorkspaceItem?.(workKey);
    });
  }
}

function bindSectionVisibility() {
  const section = document.getElementById("section-support-ops");
  if (!section || section.dataset.boundVisibility === "true") return;
  section.dataset.boundVisibility = "true";

  const observer = new MutationObserver(() => {
    if (section.classList.contains("visible")) {
      loadSupportOps().catch(() => {});
    }
  });
  observer.observe(section, {
    attributes: true,
    attributeFilter: ["class"],
  });

  document.querySelectorAll('[data-section="support-ops"]').forEach((link) => {
    if (link.dataset.boundSupportOps === "true") return;
    link.dataset.boundSupportOps = "true";
    link.addEventListener("click", () => {
      window.setTimeout(() => {
        loadSupportOps().catch(() => {});
      }, 0);
    });
  });
}

function bindSupportOps() {
  bindTicketList();
  bindFilters();
  bindControls();
  bindSectionVisibility();
  renderFilterState();
}

bindSupportOps();
window.loadSupportOps = loadSupportOps;
window.selectSupportTicketInAdmin = selectTicket;
window.openSupportTicketInAdmin = async (ticketId) => {
  const nextTicketId = String(ticketId || "").trim();
  if (!nextTicketId) return;
  window.activateAdminSection?.("support-ops");
  await loadSupportOps(true);
  await selectTicket(nextTicketId);
  document.getElementById("supportTicketDetail")?.scrollIntoView({ behavior: "smooth", block: "start" });
};

if (document.getElementById("section-support-ops")?.classList.contains("visible")) {
  loadSupportOps().catch(() => {});
}
