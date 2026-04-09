import { secureFetch } from "../auth.js";

function escapeHTML(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatDate(value) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString();
}

function titleize(value = "") {
  const text = String(value || "").replace(/_/g, " ").trim();
  if (!text) return "—";
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function isInternalTestLabel(value = "") {
  const text = String(value || "").trim().toLowerCase();
  return text.includes("cr-e2e-") || text.includes("e2e");
}

function friendlyPillarLabel(value = "") {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "knowledge") return "Knowledge";
  if (normalized === "marketing") return "Marketing";
  if (normalized === "support") return "Support";
  if (normalized === "sales") return "Sales";
  return titleize(value || "");
}

function friendlyStatusLabel(value = "") {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "pending" || normalized === "pending_review") return "Needs your decision";
  if (normalized === "approved") return "Approved";
  if (normalized === "rejected") return "Rejected";
  if (normalized === "draft") return "Draft";
  return titleize(value || "");
}

function friendlyReviewLevelLabel(value = "") {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "high") return "High care";
  if (normalized === "medium") return "Extra care";
  return "Standard";
}

function friendlyItemTypeLabel(item = {}) {
  const itemType = String(item.itemType || "").trim().toLowerCase();
  const workflowType = String(item.detail?.workflowType || "").trim().toLowerCase();
  const packetType = String(item.detail?.packetType || "").trim().toLowerCase();

  if (itemType === "knowledge_revision") return "Knowledge update";
  if (itemType === "faq_candidate") return "Help answer draft";
  if (itemType === "marketing_draft_packet") {
    if (workflowType === "linkedin_company_post") return "LinkedIn company post draft";
    if (workflowType === "facebook_page_post") return "Facebook page post draft";
    if (workflowType === "platform_update_announcement") return "Platform update draft";
    if (workflowType === "founder_linkedin_post") return "Founder LinkedIn post draft";
    return "Marketing post draft";
  }
  if (itemType === "sales_draft_packet") {
    if (packetType === "outreach_draft") return "Sales outreach draft";
    if (packetType === "account_snapshot") return "Sales account snapshot";
    if (packetType === "objection_review") return "Objection review draft";
    if (packetType === "prospect_answer") return "Prospect answer draft";
    return "Sales draft";
  }
  return titleize(item.itemType || "Approval item");
}

function friendlyApprovalTitle(item = {}) {
  const customTitle = String(item.title || "").trim();
  if (customTitle && !isInternalTestLabel(customTitle)) return customTitle;
  return friendlyItemTypeLabel(item);
}

function friendlyApprovalSummary(item = {}) {
  const accountName = String(item.detail?.accountName || "").trim();
  const targetAudience = String(item.detail?.targetAudience || "").trim();
  const sourcePillar = String(item.sourcePillar || "").trim().toLowerCase();
  const itemType = String(item.itemType || "").trim().toLowerCase();
  const workflowType = String(item.detail?.workflowType || "").trim().toLowerCase();
  const packetType = String(item.detail?.packetType || "").trim().toLowerCase();

  if (itemType === "knowledge_revision") {
    return "Review this update before it becomes the approved knowledge-base version.";
  }
  if (itemType === "faq_candidate") {
    return "Review this help answer before it is treated as approved support language.";
  }
  if (sourcePillar === "marketing") {
    if (workflowType === "linkedin_company_post") {
      return "Review this LinkedIn company post draft before it can be published.";
    }
    if (workflowType === "facebook_page_post") {
      return "Review this Facebook page draft before it can be used.";
    }
    if (workflowType === "platform_update_announcement") {
      return "Review this platform update draft before it can be shared externally.";
    }
    return "Review this marketing draft before it can be used outside LPC.";
  }
  if (sourcePillar === "sales") {
    if (packetType === "outreach_draft") {
      return accountName
        ? `Review this outreach draft before it is sent to ${accountName}.`
        : "Review this outreach draft before it is sent outside LPC.";
    }
    if (packetType === "account_snapshot") {
      return accountName
        ? `Review this account snapshot for ${accountName} before the team uses it for outreach.`
        : "Review this account snapshot before the team uses it for outreach.";
    }
    if (packetType === "objection_review") {
      return "Review this objection-handling draft before the team uses it externally.";
    }
    if (packetType === "prospect_answer") {
      return "Review this prospect answer draft before the team sends it externally.";
    }
    return "Review this sales draft before it is used outside LPC.";
  }

  const subtitle = String(item.subtitle || item.summary || "").trim();
  if (subtitle && !isInternalTestLabel(subtitle)) return subtitle;
  if (targetAudience) return `Review this item before it is used for ${targetAudience}.`;
  return "Review this item before it is used outside LPC.";
}

function isApprovalTestItem(item = {}) {
  const values = [
    item.workKey,
    item.title,
    item.subtitle,
    item.summary,
    item.createdBy,
    item.detail?.accountName,
    item.detail?.accountSummary,
    item.detail?.targetAudience,
    item.detail?.channelDraft?.subject,
    item.detail?.channelDraft?.body,
  ];
  return values.some((value) => isInternalTestLabel(value));
}

function approvalPendingOutcomeCopy(item = {}) {
  const itemType = String(item.itemType || "").trim().toLowerCase();
  if (itemType === "knowledge_revision") {
    return {
      approve: "Approve: make this revision the active approved knowledge entry.",
      reject: "Reject: keep the current approved knowledge entry and discard this revision.",
    };
  }
  if (itemType === "marketing_draft_packet") {
    return {
      approve: "Approve: mark this marketing draft approved so it can move into the downstream workflow.",
      reject: "Reject: mark this marketing draft rejected so it does not move forward.",
    };
  }
  if (itemType === "faq_candidate") {
    return {
      approve: "Approve: mark this FAQ answer approved for governed support use.",
      reject: "Reject: mark this FAQ answer rejected so it is not treated as approved language.",
    };
  }
  if (itemType === "sales_draft_packet") {
    return {
      approve: "Approve: mark this sales draft approved for downstream sales use.",
      reject: "Reject: mark this sales draft rejected so it is not used.",
    };
  }
  return {
    approve: "Approve: mark this item approved in the system.",
    reject: "Reject: mark this item rejected in the system.",
  };
}

function approvalResolvedOutcomeCopy(item = {}) {
  const itemType = String(item.itemType || "").trim().toLowerCase();
  const status = String(item.currentStatus || "").trim().toLowerCase();
  const approved = status === "approved";

  if (itemType === "knowledge_revision") {
    return approved
      ? "Approved. This revision is now the active approved knowledge entry."
      : "Rejected. The system keeps the previously approved knowledge entry instead of this revision.";
  }
  if (itemType === "marketing_draft_packet") {
    return approved
      ? "Approved. This marketing draft can now move into the downstream workflow."
      : "Rejected. This marketing draft will not move forward.";
  }
  if (itemType === "faq_candidate") {
    return approved
      ? "Approved. This FAQ answer can now be treated as governed support language."
      : "Rejected. This FAQ answer will not be treated as approved support language.";
  }
  if (itemType === "sales_draft_packet") {
    return approved
      ? "Approved. This sales draft can now be used in the downstream sales workflow."
      : "Rejected. This sales draft will not be used.";
  }
  return approved
    ? "Approved. This item is now marked approved in the system."
    : "Rejected. This item is now marked rejected in the system.";
}

function approvalQueueOutcomeHint(item = {}) {
  const copy = approvalPendingOutcomeCopy(item).approve || "";
  return copy.replace(/^Approve:\s*/i, "");
}

function friendlyContextItems(item = {}) {
  const scopes = (item.audienceScopes || []).map(titleize).join(", ");
  return [
    {
      label: "Area",
      value: friendlyPillarLabel(item.sourcePillar || ""),
    },
    {
      label: "Type",
      value: friendlyItemTypeLabel(item),
    },
    {
      label: "Status",
      value: friendlyStatusLabel(item.currentStatus || ""),
    },
    {
      label: "Review level",
      value: friendlyReviewLevelLabel(item.riskLevel || "low"),
    },
    {
      label: "Audience / scope",
      value: scopes || "—",
    },
    {
      label: "Created by",
      value: item.createdBy || "System",
    },
  ];
}

function friendlyNeedsApprovalItems(items = []) {
  return (Array.isArray(items) ? items : []).map((entry) =>
    String(entry || "")
      .replace(/\bSamantha\b/g, "you")
      .replace(/\bsamantha\b/g, "you")
      .replace(/\bfounder\b/gi, "admin")
  );
}

function friendlyFieldLabel(value = "") {
  const text = String(value || "")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/_/g, " ")
    .trim();
  if (!text) return "";
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function renderBulletList(items = [], emptyMessage = "") {
  const values = (Array.isArray(items) ? items : []).map((entry) => String(entry || "").trim()).filter(Boolean);
  if (!values.length) return emptyMessage ? `<p>${escapeHTML(emptyMessage)}</p>` : "";
  return `<ul>${values.map((entry) => `<li>${escapeHTML(entry)}</li>`).join("")}</ul>`;
}

function renderMarketingDraftDetail(detail = {}) {
  const sections = [];
  const draft = detail.channelDraft || {};
  const body = String(draft.body || "").trim();
  const openingHook = String(draft.primaryHook || draft.openingHook || "").trim();
  const cta = String(draft.closingCta || "").trim();

  if (openingHook || body || cta) {
    sections.push(`
      <section class="ai-room-focus-block">
        <h3>Draft Content</h3>
        ${openingHook ? `<p><strong>Opening:</strong> ${escapeHTML(openingHook)}</p>` : ""}
        ${body ? `<p style="white-space:pre-wrap;">${escapeHTML(body)}</p>` : "<p>No draft body is available.</p>"}
        ${cta ? `<p><strong>CTA:</strong> ${escapeHTML(cta)}</p>` : ""}
      </section>
    `);
  }

  if (Array.isArray(detail.messageHierarchy) && detail.messageHierarchy.length) {
    sections.push(`
      <section class="ai-room-focus-block">
        <h3>Main Points</h3>
        ${renderBulletList(detail.messageHierarchy)}
      </section>
    `);
  }

  if (Array.isArray(detail.claimsToAvoid) && detail.claimsToAvoid.length) {
    sections.push(`
      <section class="ai-room-focus-block">
        <h3>Claims To Avoid</h3>
        ${renderBulletList(detail.claimsToAvoid)}
      </section>
    `);
  }

  return sections.join("");
}

function renderSalesDraftDetail(detail = {}) {
  const sections = [];
  const draft = detail.channelDraft || {};
  const subject = String(draft.subject || "").trim();
  const body = String(draft.body || "").trim();

  if (subject || body) {
    sections.push(`
      <section class="ai-room-focus-block">
        <h3>Draft Content</h3>
        ${subject ? `<p><strong>Subject:</strong> ${escapeHTML(subject)}</p>` : ""}
        ${body ? `<p style="white-space:pre-wrap;">${escapeHTML(body)}</p>` : "<p>No draft text is available yet.</p>"}
      </section>
    `);
  }

  if (Array.isArray(detail.recommendedNextStep ? [detail.recommendedNextStep] : []).length) {
    sections.push(`
      <section class="ai-room-focus-block">
        <h3>Recommended Next Step</h3>
        <p>${escapeHTML(detail.recommendedNextStep || "—")}</p>
      </section>
    `);
  }

  if (Array.isArray(detail.unknowns) && detail.unknowns.length) {
    sections.push(`
      <section class="ai-room-focus-block">
        <h3>Open Questions</h3>
        ${renderBulletList(detail.unknowns)}
      </section>
    `);
  }

  if (Array.isArray(detail.riskFlags) && detail.riskFlags.length) {
    sections.push(`
      <section class="ai-room-focus-block">
        <h3>Watchouts</h3>
        ${renderBulletList(detail.riskFlags)}
      </section>
    `);
  }

  return sections.join("");
}

function renderKnowledgeDetail(detail = {}) {
  const sections = [];
  const content = detail.content || {};
  const summary = String(content.summary || content.statement || "").trim();
  const body = String(content.body || content.answer || content.approvedResponse || "").trim();

  if (summary || body) {
    sections.push(`
      <section class="ai-room-focus-block">
        <h3>Proposed Content</h3>
        ${summary ? `<p>${escapeHTML(summary)}</p>` : ""}
        ${body ? `<p style="white-space:pre-wrap;">${escapeHTML(body)}</p>` : ""}
      </section>
    `);
  }

  return sections.join("");
}

function renderSupportDetail(detail = {}) {
  return `
    <section class="ai-room-focus-block">
      <h3>Help Answer</h3>
      <p><strong>Question:</strong> ${escapeHTML(detail.question || "—")}</p>
      <p style="white-space:pre-wrap;"><strong>Draft answer:</strong> ${escapeHTML(detail.draftAnswer || "—")}</p>
    </section>
  `;
}

function renderFriendlyDetail(item = {}) {
  const sourcePillar = String(item.sourcePillar || "").trim().toLowerCase();
  if (sourcePillar === "marketing") return renderMarketingDraftDetail(item.detail || {});
  if (sourcePillar === "sales") return renderSalesDraftDetail(item.detail || {});
  if (sourcePillar === "knowledge") return renderKnowledgeDetail(item.detail || {});
  if (sourcePillar === "support") return renderSupportDetail(item.detail || {});

  const fallbackItems = Object.entries(item.detail || {})
    .map(([key, value]) => {
      if (value == null || value === "") return "";
      if (Array.isArray(value)) {
        const values = value.map((entry) => String(entry || "").trim()).filter(Boolean);
        if (!values.length) return "";
        return `${friendlyFieldLabel(key)}: ${values.join("; ")}`;
      }
      if (typeof value === "object") return "";
      return `${friendlyFieldLabel(key)}: ${String(value)}`;
    })
    .filter(Boolean);

  if (!fallbackItems.length) return "";
  return `
    <section class="ai-room-focus-block">
      <h3>Extra Detail</h3>
      ${renderBulletList(fallbackItems)}
    </section>
  `;
}

async function readJsonOrThrow(res, fallbackMessage) {
  let payload = {};
  try {
    payload = await res.json();
  } catch {
    payload = {};
  }
  if (!res.ok) throw new Error(payload?.error || fallbackMessage);
  return payload;
}

let activeWorkKey = "";
let approvalItemsCache = [];

function currentFilters() {
  return {
    pillar: document.getElementById("approvalFilterPillar")?.value || "",
    itemType: document.getElementById("approvalFilterType")?.value || "",
    status: document.getElementById("approvalFilterStatus")?.value || "",
    hideTests: document.getElementById("approvalHideTests")?.checked !== false,
  };
}

function toQuery(params = {}) {
  const query = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value) query.set(key, value);
  });
  const output = query.toString();
  return output ? `?${output}` : "";
}

function renderCounts(overview = {}) {
  const counts = overview.counts || {};
  const totalEl = document.getElementById("approvalTotalCount");
  const pendingEl = document.getElementById("approvalPendingCount");
  const kmEl = document.getElementById("approvalKnowledgeMarketingCount");
  const ssEl = document.getElementById("approvalSupportSalesCount");
  const queueCountEl = document.getElementById("approvalQueueCountLabel");
  if (totalEl) totalEl.textContent = String(counts.total || 0);
  if (pendingEl) pendingEl.textContent = String(counts.pending || 0);
  if (kmEl) kmEl.textContent = String((counts.knowledge || 0) + (counts.marketing || 0));
  if (ssEl) ssEl.textContent = String((counts.support || 0) + (counts.sales || 0));
  if (queueCountEl) {
    const pending = Number(counts.pending || 0);
    queueCountEl.textContent = pending === 1 ? "1 item needs review" : `${pending} items need review`;
  }
}

function badgeTone(item = {}) {
  if (item.currentStatus === "approved") return "healthy";
  if (item.currentStatus === "rejected") return "blocked";
  if (item.riskLevel === "medium" || item.riskLevel === "high") return "needs-review";
  return "active";
}

function renderApprovalItems(items = []) {
  approvalItemsCache = Array.isArray(items) ? items.slice() : [];
  const root = document.getElementById("approvalItemList");
  const queueCountEl = document.getElementById("approvalQueueCountLabel");
  if (!root) return;
  if (!items.length) {
    root.style.maxHeight = "";
    root.innerHTML = `<div class="ai-room-empty">No approval items match the current filters.</div>`;
    if (queueCountEl) queueCountEl.textContent = "No visible items need review";
    return;
  }

  if (queueCountEl) {
    const pendingCount = items.filter((item) => String(item.currentStatus || "").toLowerCase() === "pending").length;
    const testCount = items.filter((item) => isApprovalTestItem(item)).length;
    queueCountEl.textContent =
      pendingCount === 1 ? "1 visible item needs review" : `${pendingCount} visible items need review`;
    if (testCount > 0) {
      queueCountEl.textContent += ` · ${testCount} test ${testCount === 1 ? "item" : "items"} shown`;
    }
  }

  root.innerHTML = items
    .map(
      (item) => {
        const badges = [
          `<span class="ai-room-badge ai-room-badge--${badgeTone(item)}">${escapeHTML(
            friendlyStatusLabel(item.currentStatus || "pending")
          )}</span>`,
        ];
        if (isApprovalTestItem(item)) {
          badges.push(`<span class="ai-room-badge ai-room-badge--coming-soon">Test item</span>`);
        }
        return `
        <article class="ai-room-list-item support-list-card${item.workKey === activeWorkKey ? " support-list-card--active" : ""}" data-approval-work-key="${escapeHTML(
        item.workKey
      )}" role="button" tabindex="0" aria-pressed="${item.workKey === activeWorkKey ? "true" : "false"}">
          <div class="ai-room-list-item-top">
            <strong class="ai-room-list-item-title">${escapeHTML(friendlyApprovalTitle(item))}</strong>
            <div class="approval-card-badges">${badges.join("")}</div>
          </div>
          <p>${escapeHTML(friendlyApprovalSummary(item))}</p>
          <p class="small approval-card-meta">${escapeHTML(friendlyPillarLabel(item.sourcePillar || ""))} · ${escapeHTML(
            friendlyItemTypeLabel(item)
          )} · ${escapeHTML(friendlyReviewLevelLabel(item.riskLevel || "low"))}</p>
          ${
            String(item.currentStatus || "").toLowerCase() === "pending"
              ? `<p class="small approval-card-outcome">On approve: ${escapeHTML(approvalQueueOutcomeHint(item))}</p>`
              : ""
          }
        </article>
      `;
      }
    )
    .join("");

  syncApprovalQueueViewport(root);
}

function syncApprovalQueueViewport(root = document.getElementById("approvalItemList")) {
  if (!root) return;
  const items = Array.from(root.querySelectorAll("[data-approval-work-key]"));
  if (!items.length) {
    root.style.maxHeight = "";
    return;
  }

  const visibleCount = Math.min(items.length, 3);
  const firstItemHeight = items[0].getBoundingClientRect().height || 0;
  const styles = window.getComputedStyle(root);
  const gap = parseFloat(styles.rowGap || styles.gap || "0") || 0;
  const paddingTop = parseFloat(styles.paddingTop || "0") || 0;
  const paddingBottom = parseFloat(styles.paddingBottom || "0") || 0;
  const maxHeight = firstItemHeight * visibleCount + gap * Math.max(0, visibleCount - 1) + paddingTop + paddingBottom;
  root.style.maxHeight = items.length > 3 && maxHeight > 0 ? `${Math.ceil(maxHeight)}px` : "";
}

function renderApprovalDetailLoading(workKey = "") {
  const root = document.getElementById("approvalItemDetail");
  if (!root) return;
  root.dataset.approvalActiveWorkKey = String(workKey || "");
  root.dataset.approvalDetailState = "loading";
  root.innerHTML = `<div class="ai-room-empty">Loading review item…</div>`;
}

function revealApprovalDetail() {
  const root = document.getElementById("approvalItemDetail");
  if (!root) return;
  root.scrollIntoView({ behavior: "smooth", block: "start" });
}

function renderApprovalDetail(item = null) {
  const root = document.getElementById("approvalItemDetail");
  if (!root) return;
  if (!item) {
    root.dataset.approvalActiveWorkKey = "";
    root.dataset.approvalDetailState = "empty";
    root.innerHTML = `<div class="ai-room-empty">Select a review item to inspect its detail.</div>`;
    return;
  }
  root.dataset.approvalActiveWorkKey = String(item.workKey || activeWorkKey || "");
  root.dataset.approvalDetailState = "loaded";

  const renderList = (title, items = []) => {
    if (!Array.isArray(items) || !items.length) return "";
    return `
      <section class="ai-room-focus-block">
        <h3>${escapeHTML(title)}</h3>
        <ul>${items.map((entry) => `<li>${escapeHTML(typeof entry === "string" ? entry : JSON.stringify(entry))}</li>`).join("")}</ul>
      </section>
    `;
  };

  const citations = Array.isArray(item.citations) && item.citations.length
    ? `
      <section class="ai-room-focus-block">
        <h3>Source References</h3>
        <ul>${item.citations
          .map(
            (citation) =>
              `<li>${escapeHTML(citation.label || citation.filePath || citation.sourceKey || "Source")}: ${escapeHTML(
                citation.locator || citation.excerpt || ""
              )}</li>`
          )
          .join("")}</ul>
      </section>
    `
    : "";

  const isPendingDecision = String(item.currentStatus || "").trim().toLowerCase() === "pending";
  const actionCopy = approvalPendingOutcomeCopy(item);
  const actions = isPendingDecision && (item.actionable?.approve || item.actionable?.reject)
    ? `
      <section class="ai-room-focus-block">
        <h3>Your Decision</h3>
        <p class="small">${escapeHTML(actionCopy.approve)}</p>
        <p class="small">${escapeHTML(actionCopy.reject)}</p>
        <label class="approval-decision-label">Optional note
          <textarea class="approval-decision-note" id="approvalDecisionNote" rows="3" maxlength="2000" placeholder="Optional note for why you approved or rejected this"></textarea>
        </label>
        <div class="approval-decision-actions">
          <button class="btn" type="button" data-approval-action="approve"${item.actionable?.approve ? "" : " disabled"}>Approve</button>
          <button class="btn secondary" type="button" data-approval-action="reject"${item.actionable?.reject ? "" : " disabled"}>Reject</button>
        </div>
      </section>
    `
    : `
      <section class="ai-room-focus-block">
        <h3>What Happens Next</h3>
        <p>${escapeHTML(approvalResolvedOutcomeCopy(item))}</p>
        <p class="small">This item is no longer waiting in the pending approvals queue.</p>
      </section>
    `;

  const isTestItem = isApprovalTestItem(item);
  const statusLabel = friendlyStatusLabel(item.currentStatus || "pending");
  const noticeParts = [
    isPendingDecision ? `${statusLabel}. This item needs your approval.` : `${statusLabel}.`,
    isTestItem ? "This appears to be an internal test item." : "",
  ].filter(Boolean);
  const detailBadges = [
    `<span class="ai-room-badge ai-room-badge--${badgeTone(item)}">${escapeHTML(statusLabel)}</span>`,
  ];
  if (isTestItem) {
    detailBadges.push(`<span class="ai-room-badge ai-room-badge--coming-soon">Test item</span>`);
  }
  const noticeBlock = `
    <section class="ai-room-focus-block">
      <div class="approval-detail-badges">${detailBadges.join("")}</div>
      <p><strong>${escapeHTML(friendlyApprovalTitle(item))}</strong></p>
      <p>${escapeHTML(noticeParts.join(" "))}</p>
    </section>
  `;

  root.innerHTML = `
    ${noticeBlock}
    ${renderFriendlyDetail(item)}
    ${citations.replace("<h3>Source References</h3>", "<h3>Sources</h3>")}
    ${actions}
  `;
}

async function fetchApprovalDetail(workKey) {
  const res = await secureFetch(`/api/admin/approvals/items/${encodeURIComponent(workKey)}`, {
    headers: { Accept: "application/json" },
  });
  const payload = await res.json();
  if (!res.ok) throw new Error(payload?.error || "Unable to load approval item.");
  return payload.item;
}

async function loadApprovalsWorkspace(force = false, options = {}) {
  const preserveDetailItem = options?.preserveDetailItem || null;
  const filters = currentFilters();

  try {
    const [overviewRes, itemsRes] = await Promise.all([
      secureFetch("/api/admin/approvals/overview", { headers: { Accept: "application/json" } }),
      secureFetch(`/api/admin/approvals/items${toQuery(filters)}`, { headers: { Accept: "application/json" } }),
    ]);
    const overview = await readJsonOrThrow(overviewRes, "Unable to load approvals overview.");
    const itemsPayload = await readJsonOrThrow(itemsRes, "Unable to load approval items.");

    const rawItems = Array.isArray(itemsPayload.items) ? itemsPayload.items : [];
    const visibleItems = filters.hideTests ? rawItems.filter((item) => !isApprovalTestItem(item)) : rawItems;

    renderCounts(overview);
    renderApprovalItems(visibleItems);

    if (preserveDetailItem?.workKey) {
      activeWorkKey = String(preserveDetailItem.workKey);
      renderApprovalDetail(preserveDetailItem);
      return;
    }

    const nextWorkKey = activeWorkKey && approvalItemsCache.some((item) => item.workKey === activeWorkKey)
      ? activeWorkKey
      : approvalItemsCache[0]?.workKey || "";

    if (nextWorkKey) {
      activeWorkKey = nextWorkKey;
      renderApprovalDetailLoading(nextWorkKey);
      try {
        const item = await fetchApprovalDetail(nextWorkKey);
        renderApprovalDetail(item);
      } catch {
        renderApprovalDetail(null);
      }
    } else {
      renderApprovalDetail(null);
    }

  } catch (err) {
    activeWorkKey = "";
    renderCounts({});
    renderApprovalItems([]);
    renderApprovalDetail(null);
  }
}

async function decideApproval(action) {
  if (!activeWorkKey) return;
  const note = document.getElementById("approvalDecisionNote")?.value || "";
  try {
    const res = await secureFetch(`/api/admin/approvals/items/${encodeURIComponent(activeWorkKey)}/${action}`, {
      method: "POST",
      body: { note },
      headers: { Accept: "application/json" },
    });
    const payload = await res.json();
    if (!res.ok) throw new Error(payload?.error || `Unable to ${action} approval item.`);
    const decidedItem = payload.item || null;
    renderApprovalDetail(decidedItem);
    await loadApprovalsWorkspace(true, { preserveDetailItem: decidedItem });
  } catch (_err) {}
}

async function openApprovalWorkspaceItem(workKey = "") {
  const normalizedWorkKey = String(workKey || "").trim();
  if (!normalizedWorkKey) return;
  const pillarFilter = document.getElementById("approvalFilterPillar");
  const typeFilter = document.getElementById("approvalFilterType");
  const statusFilter = document.getElementById("approvalFilterStatus");
  if (pillarFilter) pillarFilter.value = "";
  if (typeFilter) typeFilter.value = "";
  if (statusFilter) statusFilter.value = "";
  activeWorkKey = normalizedWorkKey;
  renderApprovalItems(approvalItemsCache);
  renderApprovalDetailLoading(normalizedWorkKey);
  window.activateAdminSection?.("approvals-workspace");
  await loadApprovalsWorkspace(true);
  try {
    const item = await fetchApprovalDetail(normalizedWorkKey);
    renderApprovalDetail(item);
  } catch {
    renderApprovalDetail(null);
  }
  document.getElementById("approvalItemDetail")?.scrollIntoView({ behavior: "smooth", block: "start" });
}

function bindApprovalsWorkspace() {
  const form = document.getElementById("approvalFilterForm");
  const list = document.getElementById("approvalItemList");
  const detail = document.getElementById("approvalItemDetail");

  if (form && !form.dataset.bound) {
    form.dataset.bound = "true";
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      loadApprovalsWorkspace(true).catch(() => {});
    });
    form.addEventListener("change", () => {
      loadApprovalsWorkspace(true).catch(() => {});
    });
  }
  if (list && !list.dataset.bound) {
    list.dataset.bound = "true";
    const selectItem = async (target) => {
      const item = target.closest("[data-approval-work-key]");
      if (!item) return;
      activeWorkKey = item.getAttribute("data-approval-work-key") || "";
      renderApprovalItems(approvalItemsCache);
      renderApprovalDetailLoading(activeWorkKey);
      revealApprovalDetail();
      try {
        const detailPayload = await fetchApprovalDetail(activeWorkKey);
        renderApprovalDetail(detailPayload);
      } catch {
        renderApprovalDetail(null);
      }
    };
    list.addEventListener("click", (event) => {
      selectItem(event.target).catch(() => {});
    });
    list.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      selectItem(event.target).catch(() => {});
    });
  }
  if (detail && !detail.dataset.bound) {
    detail.dataset.bound = "true";
    detail.addEventListener("click", (event) => {
      const action = event.target.closest("[data-approval-action]")?.getAttribute("data-approval-action");
      if (!action) return;
      decideApproval(action).catch(() => {});
    });
  }
}

bindApprovalsWorkspace();
window.loadApprovalsWorkspace = loadApprovalsWorkspace;
window.openApprovalWorkspaceItem = openApprovalWorkspaceItem;

if (document.getElementById("section-approvals-workspace")?.classList.contains("visible")) {
  loadApprovalsWorkspace().catch(() => {});
}
