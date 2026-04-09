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

function packetTypeLabel(value = "") {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "account_snapshot") return "Account snapshot";
  if (normalized === "outreach_draft") return "Outreach draft";
  if (normalized === "objection_review") return "Objection review";
  if (normalized === "prospect_answer") return "Prospect answer";
  return titleize(value || "draft");
}

function approvalStateLabel(value = "") {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "pending_review") return "Needs review";
  if (normalized === "approved") return "Approved";
  if (normalized === "rejected") return "Rejected";
  return titleize(value || "draft");
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

let activeAccountId = "";
let activePacketId = "";
let accountCache = [];
let packetCache = [];

function buildSalesPacketWorkKey(packetId = "") {
  const normalizedPacketId = String(packetId || "").trim();
  return normalizedPacketId ? `sales_draft_packet:${normalizedPacketId}` : "";
}

function renderCounts(overview = {}) {
  const counts = overview.counts || {};
  const accountEl = document.getElementById("salesAccountCount");
  const interactionEl = document.getElementById("salesInteractionCount");
  const packetEl = document.getElementById("salesPacketCount");
  const pendingEl = document.getElementById("salesPendingCount");
  if (accountEl) accountEl.textContent = String(counts.accounts || 0);
  if (interactionEl) interactionEl.textContent = String(counts.interactions || 0);
  if (packetEl) packetEl.textContent = String(counts.packets || 0);
  if (pendingEl) pendingEl.textContent = String(counts.pendingReview || 0);
}

function renderAccountList(accounts = []) {
  accountCache = Array.isArray(accounts) ? accounts.slice() : [];
  const root = document.getElementById("salesAccountList");
  if (!root) return;
  if (!accounts.length) {
    root.innerHTML = `<div class="ai-room-empty">No accounts yet. Create or import one to get started.</div>`;
    return;
  }

  root.innerHTML = accounts
    .map(
      (account) => `
        <article class="ai-room-list-item support-list-card${String(account._id || account.id) === activeAccountId ? " support-list-card--active" : ""}" data-sales-account-id="${escapeHTML(
        account._id || account.id
      )}" role="button" tabindex="0" aria-pressed="${String(account._id || account.id) === activeAccountId ? "true" : "false"}">
          <div class="ai-room-list-item-top">
            <strong class="ai-room-list-item-title">${escapeHTML(account.name || "Sales account")}</strong>
            <span class="ai-room-badge ai-room-badge--active">${escapeHTML(titleize(account.audienceType || "general"))}</span>
          </div>
          <p>${escapeHTML(account.accountSummary || account.notes || account.primaryEmail || "")}</p>
          <p class="small">${escapeHTML(account.companyName || "No company")} · ${escapeHTML(
        titleize(account.sourceType || "manual")
      )}</p>
        </article>
      `
    )
    .join("");
}

function renderPacketList(packets = []) {
  packetCache = Array.isArray(packets) ? packets.slice() : [];
  const root = document.getElementById("salesPacketList");
  if (!root) return;
  if (!packets.length) {
    root.innerHTML = `<div class="ai-room-empty">No drafts yet. Open an account to create a snapshot, outreach draft, objection review, or prospect answer.</div>`;
    return;
  }

  root.innerHTML = packets
    .map(
      (packet) => `
        <article class="ai-room-list-item support-list-card${String(packet._id || packet.id) === activePacketId ? " support-list-card--active" : ""}" data-sales-packet-id="${escapeHTML(
        packet._id || packet.id
      )}" role="button" tabindex="0" aria-pressed="${String(packet._id || packet.id) === activePacketId ? "true" : "false"}">
          <div class="ai-room-list-item-top">
            <strong class="ai-room-list-item-title">${escapeHTML(packetTypeLabel(packet.packetType || "packet"))}</strong>
            <span class="ai-room-badge ai-room-badge--${packet.approvalState === "pending_review" ? "needs-review" : "active"}">${escapeHTML(
        approvalStateLabel(packet.approvalState || "pending_review")
      )}</span>
          </div>
          <p>${escapeHTML(packet.packetSummary || "")}</p>
          <p class="small">${escapeHTML(packet.recommendedNextStep || "")}</p>
        </article>
      `
    )
    .join("");
}

function renderPacketDetail(packet = null) {
  const root = document.getElementById("salesPacketDetail");
  if (!root) return;
  if (!packet) {
    root.innerHTML = `<div class="ai-room-empty">Select a draft to review the content, open questions, and next step.</div>`;
    return;
  }

  const renderList = (title, items = []) => {
    if (!Array.isArray(items) || !items.length) return "";
    return `
      <section class="ai-room-focus-block">
        <h3>${escapeHTML(title)}</h3>
        <ul>${items
          .map((item) => `<li>${escapeHTML(typeof item === "string" ? item : item.title ? `${item.title}: ${item.statement || item.summary || ""}` : JSON.stringify(item))}</li>`)
          .join("")}</ul>
      </section>
    `;
  };

  const packetId = String(packet._id || packet.id || "").trim();
  const approvalBlock =
    packet.approvalState === "pending_review"
      ? `
        <section class="ai-room-focus-block">
          <h3>Needs Review</h3>
          <p>This draft needs your approval before the team can use it.</p>
          <div class="approval-decision-actions">
            <button class="btn secondary" type="button" data-sales-open-approvals="${escapeHTML(
              buildSalesPacketWorkKey(packetId)
            )}">Open In Approvals</button>
          </div>
        </section>
      `
      : "";

  root.innerHTML = `
    ${approvalBlock}
    <section class="ai-room-focus-block">
      <h3>Draft Summary</h3>
      <p>${escapeHTML(packet.packetSummary || "")}</p>
      <p class="small">${escapeHTML(packetTypeLabel(packet.packetType || ""))} · ${escapeHTML(approvalStateLabel(packet.approvalState || ""))} · Updated ${escapeHTML(
    formatDate(packet.updatedAt)
  )}</p>
    </section>
    <section class="ai-room-focus-block">
      <h3>Account and Audience</h3>
      <p>${escapeHTML(packet.accountSummary || "—")}</p>
      <p>${escapeHTML(packet.audienceSummary || "—")}</p>
    </section>
    ${renderList("Key Talking Points", packet.approvedPositioningBlocks || [])}
    ${renderList(
      "Sources",
      (packet.citations || []).map((citation) => `${citation.label || citation.filePath || citation.sourceKey || "Source"}: ${citation.locator || citation.excerpt || ""}`)
    )}
    ${renderList("Watchouts", packet.riskFlags || [])}
    ${renderList("Open Questions", packet.unknowns || [])}
    ${renderList("What Still Needs Approval", packet.whatStillNeedsSamantha || [])}
    <section class="ai-room-focus-block">
      <h3>Recommended Next Step</h3>
      <p>${escapeHTML(packet.recommendedNextStep || "—")}</p>
    </section>
    <section class="ai-room-focus-block">
      <h3>Draft Content</h3>
      <p class="small">Type: ${escapeHTML(packet.channelDraft?.channel || "internal note")}</p>
      <p>${escapeHTML(packet.channelDraft?.subject || packet.channelDraft?.headline || "")}</p>
      <p style="white-space:pre-wrap;">${escapeHTML(packet.channelDraft?.body || "")}</p>
    </section>
  `;
}

function renderAccountDetail(payload = null) {
  const root = document.getElementById("salesAccountDetail");
  if (!root) return;
  if (!payload?.account) {
    root.innerHTML = `<div class="ai-room-empty">Select an account to review notes, add interactions, and create drafts.</div>`;
    return;
  }

  const { account, interactions = [] } = payload;
  root.innerHTML = `
    <section class="ai-room-focus-block">
      <h3>Account Summary</h3>
      <p>${escapeHTML(account.accountSummary || account.name || "")}</p>
      <p class="small">${escapeHTML(account.primaryEmail || "—")} · ${escapeHTML(account.companyName || "No company")} · ${escapeHTML(
    titleize(account.audienceType || "general")
  )} · ${escapeHTML(titleize(account.sourceType || "manual"))}</p>
    </section>
    <section class="ai-room-focus-block">
      <h3>Packet Actions</h3>
      <div style="display:flex;flex-wrap:wrap;gap:0.75rem;">
        <button class="btn secondary" type="button" data-sales-action="snapshot">Generate Account Snapshot</button>
        <button class="btn secondary" type="button" data-sales-action="outreach">Generate Outreach Draft</button>
        <button class="btn secondary" type="button" data-sales-action="objection">Generate Objection Review</button>
        <button class="btn secondary" type="button" data-sales-action="answer">Generate Prospect Answer</button>
      </div>
    </section>
    <section class="ai-room-focus-block">
      <h3>Add Interaction</h3>
      <form id="salesInteractionForm" style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:0.75rem;">
        <label>Type
          <select id="salesInteractionType">
            <option value="manual_note">Manual note</option>
            <option value="email_note">Email note</option>
            <option value="call_note">Call note</option>
            <option value="objection_note">Objection note</option>
            <option value="meeting_note">Meeting note</option>
          </select>
        </label>
        <label>Direction
          <select id="salesInteractionDirection">
            <option value="internal">Internal</option>
            <option value="inbound">Inbound</option>
            <option value="outbound">Outbound</option>
          </select>
        </label>
        <label style="grid-column:1 / -1;">Summary
          <input id="salesInteractionSummary" type="text" maxlength="2000" placeholder="Short factual note" required />
        </label>
        <label style="grid-column:1 / -1;">Objections
          <input id="salesInteractionObjections" type="text" maxlength="1000" placeholder="Comma-separated objections if any" />
        </label>
        <label style="grid-column:1 / -1;">Raw Note
          <textarea id="salesInteractionRawText" rows="4" maxlength="12000" placeholder="Internal note only. Keep it factual."></textarea>
        </label>
        <div style="grid-column:1 / -1;display:flex;justify-content:flex-end;">
          <button class="btn" type="submit">Add Interaction</button>
        </div>
      </form>
    </section>
    <section class="ai-room-focus-block">
      <h3>Recent Interactions</h3>
      <ul>${interactions.length
        ? interactions
            .map(
              (interaction) =>
                `<li>${escapeHTML(interaction.summary || "")} <span class="small">(${escapeHTML(
                  titleize(interaction.interactionType || "")
                )} · ${escapeHTML(formatDate(interaction.createdAt))})</span></li>`
            )
            .join("")
        : "<li>No interactions recorded yet.</li>"}</ul>
    </section>
  `;
}

async function fetchAccountDetail(accountId) {
  const res = await secureFetch(`/api/admin/sales/accounts/${encodeURIComponent(accountId)}`, {
    headers: { Accept: "application/json" },
  });
  const payload = await res.json();
  if (!res.ok) throw new Error(payload?.error || "Unable to load sales account.");
  return payload;
}

async function fetchPacketDetail(packetId) {
  const res = await secureFetch(`/api/admin/sales/draft-packets/${encodeURIComponent(packetId)}`, {
    headers: { Accept: "application/json" },
  });
  const payload = await res.json();
  if (!res.ok) throw new Error(payload?.error || "Unable to load sales draft.");
  return payload.packet;
}

async function loadSalesWorkspace(force = false) {
  const status = document.getElementById("salesFormStatus");
  if (status && force) status.textContent = "Loading sales…";

  try {
    const [overviewRes, accountsRes, packetsRes] = await Promise.all([
      secureFetch("/api/admin/sales/overview", { headers: { Accept: "application/json" } }),
      secureFetch("/api/admin/sales/accounts", { headers: { Accept: "application/json" } }),
      secureFetch("/api/admin/sales/draft-packets", { headers: { Accept: "application/json" } }),
    ]);
    const overview = await readJsonOrThrow(overviewRes, "Unable to load sales overview.");
    const accountsPayload = await readJsonOrThrow(accountsRes, "Unable to load sales accounts.");
    const packetsPayload = await readJsonOrThrow(packetsRes, "Unable to load sales drafts.");

    renderCounts(overview);
    renderAccountList(accountsPayload.accounts || []);
    renderPacketList(packetsPayload.packets || []);

    const nextAccountId = activeAccountId || accountsPayload.accounts?.[0]?._id;
    if (nextAccountId) {
      activeAccountId = String(nextAccountId);
      try {
        const detail = await fetchAccountDetail(activeAccountId);
        renderAccountDetail(detail);
      } catch {
        renderAccountDetail(null);
      }
    } else {
      renderAccountDetail(null);
    }

    const nextPacketId = activePacketId || packetsPayload.packets?.[0]?._id;
    if (nextPacketId) {
      activePacketId = String(nextPacketId);
      try {
        const packet = await fetchPacketDetail(activePacketId);
        renderPacketDetail(packet);
      } catch {
        renderPacketDetail(null);
      }
    } else {
      renderPacketDetail(null);
    }

    if (status && force) status.textContent = "Sales loaded.";
  } catch (err) {
    activeAccountId = "";
    activePacketId = "";
    renderCounts({});
    renderAccountList([]);
    renderPacketList([]);
    renderAccountDetail(null);
    renderPacketDetail(null);
    if (status) status.textContent = err?.message || "Unable to load sales.";
  }
}

async function createSalesAccount(event) {
  event.preventDefault();
  const status = document.getElementById("salesFormStatus");
  const submitBtn = document.getElementById("salesCreateAccountBtn");
  if (submitBtn) submitBtn.disabled = true;
  if (status) status.textContent = "Creating sales account…";

  try {
    const payload = {
      name: document.getElementById("salesAccountName")?.value || "",
      primaryEmail: document.getElementById("salesPrimaryEmail")?.value || "",
      audienceType: document.getElementById("salesAudienceType")?.value || "general",
      roleLabel: document.getElementById("salesRoleLabel")?.value || "",
      companyName: document.getElementById("salesCompanyName")?.value || "",
      accountSummary: document.getElementById("salesAccountSummary")?.value || "",
    };
    const res = await secureFetch("/api/admin/sales/accounts", {
      method: "POST",
      body: payload,
      headers: { Accept: "application/json" },
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data?.error || "Unable to create sales account.");
    activeAccountId = String(data.account._id);
    if (status) status.textContent = "Sales account created.";
    await loadSalesWorkspace(true);
  } catch (err) {
    if (status) status.textContent = err?.message || "Unable to create sales account.";
  } finally {
    if (submitBtn) submitBtn.disabled = false;
  }
}

async function importPublicSignals() {
  const status = document.getElementById("salesFormStatus");
  if (status) status.textContent = "Importing public contact signals…";
  try {
    const res = await secureFetch("/api/admin/sales/accounts/import-public-signals", {
      method: "POST",
      body: {},
      headers: { Accept: "application/json" },
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data?.error || "Unable to import public contact signals.");
    if (status) status.textContent = `${(data.accounts || []).length} public contact signal${(data.accounts || []).length === 1 ? "" : "s"} imported.`;
    await loadSalesWorkspace(true);
  } catch (err) {
    if (status) status.textContent = err?.message || "Unable to import public contact signals.";
  }
}

async function addSalesInteraction(event) {
  event.preventDefault();
  const status = document.getElementById("salesFormStatus");
  if (!activeAccountId) return;
  if (status) status.textContent = "Adding sales interaction…";
  try {
    const payload = {
      interactionType: document.getElementById("salesInteractionType")?.value || "manual_note",
      direction: document.getElementById("salesInteractionDirection")?.value || "internal",
      summary: document.getElementById("salesInteractionSummary")?.value || "",
      rawText: document.getElementById("salesInteractionRawText")?.value || "",
      objections: (document.getElementById("salesInteractionObjections")?.value || "")
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean),
    };
    const res = await secureFetch(`/api/admin/sales/accounts/${encodeURIComponent(activeAccountId)}/interactions`, {
      method: "POST",
      body: payload,
      headers: { Accept: "application/json" },
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data?.error || "Unable to add sales interaction.");
    if (status) status.textContent = "Sales interaction added.";
    const detail = await fetchAccountDetail(activeAccountId);
    renderAccountDetail(detail);
    await loadSalesWorkspace(true);
  } catch (err) {
    if (status) status.textContent = err?.message || "Unable to add sales interaction.";
  }
}

async function generateSalesPacket(action) {
  const status = document.getElementById("salesFormStatus");
  if (!activeAccountId) return;
  const endpointMap = {
    snapshot: `/api/admin/sales/accounts/${encodeURIComponent(activeAccountId)}/account-snapshot`,
    outreach: `/api/admin/sales/accounts/${encodeURIComponent(activeAccountId)}/outreach-draft`,
    objection: `/api/admin/sales/accounts/${encodeURIComponent(activeAccountId)}/objection-review`,
    answer: `/api/admin/sales/accounts/${encodeURIComponent(activeAccountId)}/prospect-answer`,
  };
  const body =
    action === "outreach"
      ? { outreachGoal: "Draft a restrained outreach note grounded in approved LPC positioning." }
      : action === "answer"
        ? { incomingQuestion: "How should LPC be explained truthfully for this account?" }
        : {};
  if (status) status.textContent = "Generating sales draft…";
  try {
    const res = await secureFetch(endpointMap[action], {
      method: "POST",
      body,
      headers: { Accept: "application/json" },
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data?.error || "Unable to generate sales draft.");
    activePacketId = String(data.packet._id);
    if (status) status.textContent = "Sales draft created and added to the review list.";
    await loadSalesWorkspace(true);
  } catch (err) {
    if (status) status.textContent = err?.message || "Unable to generate sales draft.";
  }
}

function bindSalesWorkspace() {
  const form = document.getElementById("salesAccountForm");
  const refreshBtn = document.getElementById("salesRefreshBtn");
  const importBtn = document.getElementById("salesImportSignalsBtn");
  const accountList = document.getElementById("salesAccountList");
  const packetList = document.getElementById("salesPacketList");
  const accountDetail = document.getElementById("salesAccountDetail");
  const packetDetail = document.getElementById("salesPacketDetail");

  if (form && !form.dataset.bound) {
    form.dataset.bound = "true";
    form.addEventListener("submit", createSalesAccount);
  }
  if (refreshBtn && !refreshBtn.dataset.bound) {
    refreshBtn.dataset.bound = "true";
    refreshBtn.addEventListener("click", () => loadSalesWorkspace(true));
  }
  if (importBtn && !importBtn.dataset.bound) {
    importBtn.dataset.bound = "true";
    importBtn.addEventListener("click", importPublicSignals);
  }
  if (accountList && !accountList.dataset.bound) {
    accountList.dataset.bound = "true";
    const selectAccount = async (target) => {
      const item = target.closest("[data-sales-account-id]");
      if (!item) return;
      activeAccountId = item.getAttribute("data-sales-account-id") || "";
      renderAccountList(accountCache);
      try {
        const detail = await fetchAccountDetail(activeAccountId);
        renderAccountDetail(detail);
      } catch {
        renderAccountDetail(null);
      }
    };
    accountList.addEventListener("click", (event) => {
      selectAccount(event.target).catch(() => {});
    });
    accountList.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      selectAccount(event.target).catch(() => {});
    });
  }
  if (packetList && !packetList.dataset.bound) {
    packetList.dataset.bound = "true";
    const selectPacket = async (target) => {
      const item = target.closest("[data-sales-packet-id]");
      if (!item) return;
      activePacketId = item.getAttribute("data-sales-packet-id") || "";
      renderPacketList(packetCache);
      try {
        const packet = await fetchPacketDetail(activePacketId);
        renderPacketDetail(packet);
      } catch {
        renderPacketDetail(null);
      }
    };
    packetList.addEventListener("click", (event) => {
      selectPacket(event.target).catch(() => {});
    });
    packetList.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      selectPacket(event.target).catch(() => {});
    });
  }
  if (accountDetail && !accountDetail.dataset.bound) {
    accountDetail.dataset.bound = "true";
    accountDetail.addEventListener("submit", (event) => {
      if (event.target?.id === "salesInteractionForm") {
        addSalesInteraction(event).catch(() => {});
      }
    });
    accountDetail.addEventListener("click", (event) => {
      const button = event.target.closest("[data-sales-action]");
      if (!button) return;
      generateSalesPacket(button.getAttribute("data-sales-action")).catch(() => {});
    });
  }
  if (packetDetail && !packetDetail.dataset.bound) {
    packetDetail.dataset.bound = "true";
    packetDetail.addEventListener("click", (event) => {
      const approvalButton = event.target.closest("[data-sales-open-approvals]");
      if (!approvalButton) return;
      const workKey = approvalButton.getAttribute("data-sales-open-approvals") || "";
      window.openApprovalWorkspaceItem?.(workKey);
    });
  }
}

bindSalesWorkspace();
window.loadSalesWorkspace = loadSalesWorkspace;

if (document.getElementById("section-sales-workspace")?.classList.contains("visible")) {
  loadSalesWorkspace().catch(() => {});
}
