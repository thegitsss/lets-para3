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
  return String(value || "")
    .split(/[_\s]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function sentenceCase(value = "") {
  const text = String(value || "").replace(/_/g, " ").trim();
  if (!text) return "—";
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function normalizeArray(value = []) {
  return Array.isArray(value) ? value.filter(Boolean) : [];
}

function compactText(value = "", fallback = "—") {
  const text = String(value || "").trim();
  return text || fallback;
}

function approvalTone(value = "") {
  if (value === "approved") return "healthy";
  if (value === "pending" || value === "pending_review") return "needs-review";
  if (value === "rejected") return "blocked";
  return "active";
}

function revisionTone(value = "") {
  if (value === "approved") return "healthy";
  if (value === "pending") return "needs-review";
  if (value === "rejected") return "blocked";
  return "active";
}

function summarizeState(item = {}) {
  if (item.approvalState === "approved") return "Approved record";
  if (item.approvalState === "pending") return "Pending review";
  if (item.approvalState === "rejected") return "Rejected revision";
  return "Draft record";
}

function summarizeProvenance(revision = {}, item = {}) {
  if (item.approvalState === "approved" && revision?.createdFrom === "seed_sync") {
    return "Seeded from approved LPC source material.";
  }
  if (revision?.approvalState === "pending" || revision?.approvalState === "pending_review") {
    return "A newer revision is awaiting review.";
  }
  if (item.approvalState === "approved") {
    return "Current approved revision is active.";
  }
  return "Current revision is not yet approved.";
}

function findPendingRevision(revisions = []) {
  return (Array.isArray(revisions) ? revisions : []).find(
    (revision) => {
      const state = String(revision?.approvalState || "").trim().toLowerCase();
      return state === "pending_review" || state === "pending";
    }
  ) || null;
}

function findActiveRevision(item = {}, revisions = []) {
  const activeId = String(item.currentApprovedRevisionId || item.currentRevisionId || "");
  if (!activeId) return revisions[0] || null;
  return revisions.find((revision) => String(revision._id) === activeId) || revisions[0] || null;
}

function summarizeCardBody(item = {}) {
  return compactText(item.summary || item.approvedResponse || item.statement, "No governed summary is available yet.");
}

let loadPromise = null;
let selectedItemId = "";
let selectedLoadToken = 0;
let latestItems = [];

function renderCounts(counts = {}) {
  const sourceCount = document.getElementById("knowledgeSourceCount");
  const collectionCount = document.getElementById("knowledgeCollectionCount");
  const itemCount = document.getElementById("knowledgeItemCount");
  const pendingCount = document.getElementById("knowledgePendingCount");
  if (sourceCount) sourceCount.textContent = String(counts.sources || 0);
  if (collectionCount) collectionCount.textContent = String(counts.collections || 0);
  if (itemCount) itemCount.textContent = String(counts.items || 0);
  if (pendingCount) pendingCount.textContent = String(counts.pendingApprovals || 0);
}

function renderSources(sources = []) {
  const root = document.getElementById("knowledgeSourceList");
  if (!root) return;
  if (!sources.length) {
    root.innerHTML = `<div class="ai-room-empty">No knowledge sources loaded yet.</div>`;
    return;
  }

  root.innerHTML = sources
    .map(
      (source) => `
        <article class="ai-room-list-item">
          <div class="ai-room-list-item-top">
            <strong class="ai-room-list-item-title">${escapeHTML(source.title || source.sourceKey)}</strong>
            <span class="ai-room-badge ai-room-badge--${source.syncState === "error" ? "blocked" : "active"}">${escapeHTML(
        source.syncState || "unknown"
      )}</span>
          </div>
          <p>${escapeHTML(source.filePath || "")}</p>
          <p class="small">Last synced: ${escapeHTML(formatDate(source.lastSyncedAt))}</p>
        </article>
      `
    )
    .join("");
}

function renderItems(items = []) {
  const root = document.getElementById("knowledgeItemList");
  if (!root) return;
  latestItems = items;
  if (!items.length) {
    root.innerHTML = `<div class="ai-room-empty">No knowledge items loaded yet.</div>`;
    return;
  }

  root.innerHTML = items
    .map((item) => {
      const isSelected = String(item.id) === String(selectedItemId);
      const scopes = normalizeArray(item.audienceScopes).map(titleize).join(" · ");
      return `
        <article
          class="ai-room-list-item knowledge-card${isSelected ? " knowledge-card--active" : ""}"
          data-knowledge-item-id="${escapeHTML(item.id)}"
          role="button"
          tabindex="0"
          aria-pressed="${isSelected ? "true" : "false"}"
        >
          <div class="ai-room-list-item-top">
            <strong class="ai-room-list-item-title">${escapeHTML(item.title)}</strong>
            <span class="ai-room-badge ai-room-badge--${approvalTone(item.approvalState)}">${escapeHTML(
        sentenceCase(item.approvalState || "draft")
      )}</span>
          </div>
          <p>${escapeHTML(summarizeCardBody(item))}</p>
          <div class="knowledge-card-meta">
            <span>${escapeHTML(titleize(item.domain || ""))}</span>
            <span>${escapeHTML(titleize(item.recordType || ""))}</span>
            <span>${escapeHTML(scopes || "Internal Ops")}</span>
          </div>
          <p class="knowledge-card-state">${escapeHTML(summarizeState(item))}</p>
        </article>
      `;
    })
    .join("");
}

function renderApprovals(approvals = []) {
  const root = document.getElementById("knowledgeApprovalList");
  if (!root) return;
  const pending = approvals.filter((approval) => approval.approvalState === "pending");
  if (!pending.length) {
    root.innerHTML = `<div class="ai-room-empty">No knowledge approvals are pending.</div>`;
    return;
  }
  root.innerHTML = pending
    .map(
      (approval) => `
        <article
          class="ai-room-list-item knowledge-card"
          data-knowledge-approval-item-id="${escapeHTML(approval.parentId || "")}"
          data-knowledge-approval-work-key="${escapeHTML(
            approval.targetId ? `knowledge_revision:${approval.targetId}` : ""
          )}"
          role="button"
          tabindex="0"
          aria-pressed="false"
        >
          <div class="ai-room-list-item-top">
            <strong class="ai-room-list-item-title">${escapeHTML(approval.title || "Pending knowledge review")}</strong>
            <span class="ai-room-badge ai-room-badge--needs-review">Pending</span>
          </div>
          <p>${escapeHTML(approval.summary || "")}</p>
          <p class="small">Assigned to: ${escapeHTML(approval.assignedOwnerLabel || "Admin")}</p>
        </article>
      `
    )
    .join("");
}

function renderKnowledgeDetailLoading() {
  const root = document.getElementById("knowledgeDetailPanel");
  if (!root) return;
  root.innerHTML = `<div class="ai-room-empty">Loading knowledge record…</div>`;
}

function renderKnowledgeDetailEmpty(message = "Select a knowledge record to review its current approved detail.") {
  const root = document.getElementById("knowledgeDetailPanel");
  if (!root) return;
  root.innerHTML = `<div class="ai-room-empty">${escapeHTML(message)}</div>`;
}

function renderKeyValueList(entries = []) {
  return entries
    .filter((entry) => entry?.value)
    .map(
      (entry) => `
        <div class="knowledge-detail-meta-item">
          <span class="knowledge-detail-meta-label">${escapeHTML(entry.label)}</span>
          <strong class="knowledge-detail-meta-value">${escapeHTML(entry.value)}</strong>
        </div>
      `
    )
    .join("");
}

function renderDetailSection(title, content) {
  if (!content) return "";
  return `
    <section class="knowledge-detail-section">
      <h3>${escapeHTML(title)}</h3>
      ${content}
    </section>
  `;
}

function renderList(title, items = []) {
  const values = normalizeArray(items);
  if (!values.length) return "";
  return renderDetailSection(
    title,
    `<ul class="knowledge-detail-list">${values.map((value) => `<li>${escapeHTML(value)}</li>`).join("")}</ul>`
  );
}

function renderCitations(citations = []) {
  const values = normalizeArray(citations);
  if (!values.length) {
    return `<div class="ai-room-empty">No citations are attached to this revision.</div>`;
  }
  return `
    <div class="knowledge-citation-list">
      ${values
        .map(
          (citation) => `
            <article class="knowledge-citation">
              <div class="knowledge-citation-top">
                <strong>${escapeHTML(citation.label || citation.filePath || citation.sourceKey || "Source")}</strong>
                <span>${escapeHTML(citation.locator || "")}</span>
              </div>
              <p>${escapeHTML(citation.filePath || "")}</p>
              <blockquote>${escapeHTML(citation.excerpt || "")}</blockquote>
            </article>
          `
        )
        .join("")}
    </div>
  `;
}

function renderKnowledgeDetail(item = {}, revisions = []) {
  const root = document.getElementById("knowledgeDetailPanel");
  if (!root) return;

  const activeRevision = findActiveRevision(item, revisions);
  const pendingRevision = findPendingRevision(revisions);
  const activeContent = activeRevision?.content || {};
  const bodyText = compactText(
    activeContent.statement || activeContent.approvedResponse || activeContent.summary,
    "No governed content is available for this revision yet."
  );
  const approvalWorkKey = pendingRevision?._id ? `knowledge_revision:${pendingRevision._id}` : "";

  const metadata = renderKeyValueList([
    { label: "Audience scope", value: normalizeArray(item.audienceScopes).map(titleize).join(", ") || "Internal Ops" },
    { label: "Approval status", value: sentenceCase(item.approvalState || "draft") },
    { label: "Active revision", value: activeRevision ? `Revision ${activeRevision.revisionNumber || 1}` : "—" },
    { label: "Revision state", value: sentenceCase(activeRevision?.approvalState || "draft") },
    { label: "Record type", value: titleize(item.recordType || "") },
    { label: "Domain", value: titleize(item.domain || "") },
    { label: "Owner", value: compactText(item.ownerLabel, "Samantha") },
    { label: "Freshness", value: item.freshnessDays ? `${item.freshnessDays} days` : "" },
    { label: "Last reviewed", value: item.lastReviewedAt ? formatDate(item.lastReviewedAt) : "" },
    { label: "Next review", value: item.nextReviewAt ? formatDate(item.nextReviewAt) : "" },
    { label: "Created from", value: activeRevision?.createdFrom ? titleize(activeRevision.createdFrom) : "" },
    { label: "Approved at", value: activeRevision?.approvedAt ? formatDate(activeRevision.approvedAt) : "" },
  ]);

  root.innerHTML = `
    <article class="knowledge-detail">
      <div class="knowledge-detail-top">
        <div>
          <p class="knowledge-detail-kicker">${escapeHTML(titleize(item.domain || "knowledge"))}</p>
          <h3>${escapeHTML(item.title || "Knowledge record")}</h3>
        </div>
        <span class="ai-room-badge ai-room-badge--${approvalTone(item.approvalState)}">${escapeHTML(
    sentenceCase(item.approvalState || "draft")
  )}</span>
      </div>
      <p class="knowledge-detail-summary">${escapeHTML(compactText(activeContent.summary || item.summary, bodyText))}</p>
      <p class="knowledge-detail-note">${escapeHTML(summarizeProvenance(activeRevision, item))}</p>
      <div class="knowledge-detail-meta-grid">
        ${metadata}
      </div>
      ${
        pendingRevision
          ? `
            <section class="knowledge-detail-section">
              <h3>Pending Revision Decision</h3>
              <p>${escapeHTML(
                pendingRevision.changeSummary ||
                  "A newer revision is waiting for approval before it replaces the current governed content."
              )}</p>
              <p class="knowledge-detail-note">Revision ${escapeHTML(
                String(pendingRevision.revisionNumber || "—")
              )} was created ${escapeHTML(formatDate(pendingRevision.createdAt))}.</p>
              <label class="approval-decision-label">Optional note
                <textarea class="approval-decision-note" id="knowledgeDecisionNote" rows="3" maxlength="2000" placeholder="Optional approval or rejection note"></textarea>
              </label>
              <div class="approval-decision-actions">
                <button class="btn" type="button" data-knowledge-action="approve" data-knowledge-revision-id="${escapeHTML(
                  String(pendingRevision._id)
                )}">Approve Revision</button>
                <button class="btn secondary" type="button" data-knowledge-action="reject" data-knowledge-revision-id="${escapeHTML(
                  String(pendingRevision._id)
                )}">Reject Revision</button>
                <button class="btn secondary" type="button" data-knowledge-action="open-approvals" data-knowledge-work-key="${escapeHTML(
                  approvalWorkKey
                )}">Open In Approvals</button>
              </div>
            </section>
          `
          : ""
      }
      ${renderDetailSection("Current Governed Content", `<p>${escapeHTML(bodyText)}</p>`)}
      ${renderList("Supporting Points", activeContent.supportingPoints)}
      ${renderList("Founder Voice Rules", activeContent.rules)}
      ${renderList("Claims To Avoid", activeContent.claimsToAvoid)}
      ${renderDetailSection(
        "Tags",
        normalizeArray(item.tags).length
          ? `<div class="knowledge-tag-list">${normalizeArray(item.tags)
              .map((tag) => `<span class="knowledge-tag">${escapeHTML(titleize(tag))}</span>`)
              .join("")}</div>`
          : ""
      )}
      ${renderDetailSection("Source References", renderCitations(activeRevision?.citations || []))}
      ${renderDetailSection(
        "Revision Timeline",
        revisions.length
          ? `<div class="knowledge-revision-list">${revisions
              .map(
                (revision) => `
                  <div class="knowledge-revision-item">
                    <div>
                      <strong>Revision ${escapeHTML(String(revision.revisionNumber || 1))}</strong>
                      <p>${escapeHTML(formatDate(revision.createdAt))}</p>
                    </div>
                    <span class="ai-room-badge ai-room-badge--${revisionTone(revision.approvalState)}">${escapeHTML(
                  sentenceCase(revision.approvalState || "draft")
                )}</span>
                  </div>
                `
              )
              .join("")}</div>`
          : `<div class="ai-room-empty">No revisions are available for this record.</div>`
      )}
    </article>
  `;
}

async function decideKnowledgeRevision(action = "", revisionId = "") {
  const normalizedAction = String(action || "").trim();
  const normalizedRevisionId = String(revisionId || "").trim();
  const status = document.getElementById("knowledgeSyncStatus");
  if (!normalizedAction || !normalizedRevisionId) return;
  const note = document.getElementById("knowledgeDecisionNote")?.value || "";
  const successMessage = `Knowledge revision ${normalizedAction}d.`;
  if (status) status.textContent = `${titleize(normalizedAction)}ing knowledge revision…`;
  try {
    const res = await secureFetch(
      `/api/admin/knowledge/revisions/${encodeURIComponent(normalizedRevisionId)}/${normalizedAction}`,
      {
        method: "POST",
        body: { note },
        headers: { Accept: "application/json" },
      }
    );
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(payload?.error || `Unable to ${normalizedAction} knowledge revision.`);
    await loadKnowledgeStudio(true);
    if (status) status.textContent = successMessage;
  } catch (err) {
    if (status) status.textContent = err?.message || `Unable to ${normalizedAction} knowledge revision.`;
  }
}

async function loadKnowledgeItemDetail(itemId, { preserveSelection = false } = {}) {
  if (!itemId) {
    renderKnowledgeDetailEmpty();
    return;
  }

  const token = ++selectedLoadToken;
  if (!preserveSelection) {
    selectedItemId = String(itemId);
    renderItems(latestItems);
  }
  renderKnowledgeDetailLoading();

  try {
    const res = await secureFetch(`/api/admin/knowledge/items/${encodeURIComponent(itemId)}`, {
      headers: { Accept: "application/json" },
    });
    const payload = await res.json();
    if (!res.ok) throw new Error(payload?.error || "Unable to load knowledge item.");
    if (token !== selectedLoadToken) return;
    selectedItemId = String(itemId);
    renderItems(latestItems);
    renderKnowledgeDetail(payload.item || {}, payload.revisions || []);
  } catch (err) {
    if (token !== selectedLoadToken) return;
    renderKnowledgeDetailEmpty(err?.message || "Unable to load knowledge item.");
  }
}

async function loadKnowledgeStudio(force = false) {
  if (loadPromise && !force) return loadPromise;

  const syncStatus = document.getElementById("knowledgeSyncStatus");
  if (syncStatus) syncStatus.textContent = "Loading knowledge studio…";

  loadPromise = (async () => {
    const [overviewRes, sourcesRes, approvalsRes] = await Promise.all([
      secureFetch("/api/admin/knowledge/overview", { headers: { Accept: "application/json" } }),
      secureFetch("/api/admin/knowledge/sources", { headers: { Accept: "application/json" } }),
      secureFetch("/api/admin/knowledge/approvals", { headers: { Accept: "application/json" } }),
    ]);

    const overview = await overviewRes.json();
    const sources = await sourcesRes.json();
    const approvals = await approvalsRes.json();

    renderCounts(overview.counts || {});
    renderSources(sources.sources || []);
    renderItems(overview.latestItems || []);
    renderApprovals(approvals.approvals || []);

    const preferredItemId =
      latestItems.find((item) => String(item.id) === String(selectedItemId))?.id || latestItems[0]?.id || "";
    if (preferredItemId) {
      await loadKnowledgeItemDetail(preferredItemId, { preserveSelection: true });
    } else {
      renderKnowledgeDetailEmpty("No knowledge records are available yet.");
    }

    if (syncStatus) {
      syncStatus.textContent = "Phase 1 seed sources loaded.";
    }
  })();

  try {
    await loadPromise;
  } catch (err) {
    if (syncStatus) syncStatus.textContent = err?.message || "Unable to load knowledge studio.";
    renderKnowledgeDetailEmpty(err?.message || "Unable to load knowledge studio.");
  } finally {
    loadPromise = null;
  }
}

async function syncKnowledgeSources() {
  const status = document.getElementById("knowledgeSyncStatus");
  const button = document.getElementById("knowledgeSyncBtn");
  if (button) button.disabled = true;
  if (status) status.textContent = "Syncing Phase 1 sources…";
  try {
    const res = await secureFetch("/api/admin/knowledge/sync", {
      method: "POST",
      body: {},
      headers: { Accept: "application/json" },
    });
    const payload = await res.json();
    if (!res.ok) throw new Error(payload?.error || "Unable to sync knowledge sources.");
    let summaryMessage = "";
    if (status) {
      const summary = payload.summary || {};
      summaryMessage = `Synced ${summary.syncedSources || 0} sources · created ${summary.createdItems || 0} items · pending ${summary.pendingRevisions || 0} revisions.`;
      status.textContent = summaryMessage;
    }
    await loadKnowledgeStudio(true);
    if (status && summaryMessage) status.textContent = summaryMessage;
  } catch (err) {
    if (status) status.textContent = err?.message || "Unable to sync knowledge sources.";
  } finally {
    if (button) button.disabled = false;
  }
}

function bindKnowledgeStudio() {
  const syncBtn = document.getElementById("knowledgeSyncBtn");
  if (syncBtn && !syncBtn.dataset.bound) {
    syncBtn.dataset.bound = "true";
    syncBtn.addEventListener("click", syncKnowledgeSources);
  }

  const itemList = document.getElementById("knowledgeItemList");
  if (itemList && !itemList.dataset.bound) {
    itemList.dataset.bound = "true";
    itemList.addEventListener("click", (event) => {
      const card = event.target.closest("[data-knowledge-item-id]");
      if (!card) return;
      loadKnowledgeItemDetail(card.dataset.knowledgeItemId).catch(() => {});
    });
    itemList.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      const card = event.target.closest("[data-knowledge-item-id]");
      if (!card) return;
      event.preventDefault();
      loadKnowledgeItemDetail(card.dataset.knowledgeItemId).catch(() => {});
    });
  }

  const approvalList = document.getElementById("knowledgeApprovalList");
  if (approvalList && !approvalList.dataset.bound) {
    approvalList.dataset.bound = "true";
    const openApprovalItem = (target) => {
      const card = target?.closest("[data-knowledge-approval-item-id]");
      if (!card) return;
      const itemId = card.getAttribute("data-knowledge-approval-item-id") || "";
      if (itemId) {
        loadKnowledgeItemDetail(itemId).catch(() => {});
        return;
      }
      const workKey = card.getAttribute("data-knowledge-approval-work-key") || "";
      if (workKey) window.openApprovalWorkspaceItem?.(workKey);
    };
    approvalList.addEventListener("click", (event) => {
      openApprovalItem(event.target);
    });
    approvalList.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      openApprovalItem(event.target);
    });
  }

  const detailPanel = document.getElementById("knowledgeDetailPanel");
  if (detailPanel && !detailPanel.dataset.bound) {
    detailPanel.dataset.bound = "true";
    detailPanel.addEventListener("click", (event) => {
      const actionButton = event.target.closest("[data-knowledge-action]");
      if (!actionButton) return;
      const action = actionButton.getAttribute("data-knowledge-action") || "";
      if (action === "open-approvals") {
        const workKey = actionButton.getAttribute("data-knowledge-work-key") || "";
        window.openApprovalWorkspaceItem?.(workKey);
        return;
      }
      const revisionId = actionButton.getAttribute("data-knowledge-revision-id") || "";
      decideKnowledgeRevision(action, revisionId).catch(() => {});
    });
  }
}

bindKnowledgeStudio();
window.loadKnowledgeStudio = loadKnowledgeStudio;

if (document.getElementById("section-knowledge-studio")?.classList.contains("visible")) {
  loadKnowledgeStudio().catch(() => {});
}
