import { secureFetch } from "./auth.js";
import { commissionLabel, commissionCount, commissionMoney, commissionPaymentLabel, commissionAccount } from "./utils/director-financials.mjs";
import { activateDialogFocus, deactivateDialogFocus } from "./utils/dialog-focus.js";

import { createPaymentDialog, paymentHistory } from "./utils/director-payment-dialog.mjs";
const financialAccount = commissionAccount("admin");
const paymentDialog = createPaymentDialog({ account: financialAccount, onSaved: async () => { closeAudit(); await loadOverview(); }, onDenied: clearFinancialView });
let loadSequence = 0, auditSequence = 0;

function escapeHTML(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function date(value) {
  if (!value) return "—";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "—";
  return parsed.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function dateTime(value) {
  if (!value) return "Never";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "Never";
  return parsed.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function syncLabel(status) {
  const normalized = String(status || "never").toLowerCase();
  if (normalized === "success") return "Healthy";
  if (normalized === "partial") return "Partial";
  if (normalized === "failed") return "Needs Attention";
  return "Not Synced";
}

function payoutBadge(record = {}) {
  const label = commissionPaymentLabel(record);
  return label === "—" ? "" : `<span class="badge neutral">${escapeHTML(label)}</span>`;
}

async function readJsonOrThrow(res, fallback, financial = false) {
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(res.status >= 500 ? fallback : payload?.error || fallback), { status: res.status });
  financialAccount.verify(financial ? payload : undefined);
  return payload;
}

function setStatus(message) {
  const el = document.getElementById("directorAdminStatus");
  if (el) el.textContent = message || "";
}

function renderDirectors(directors = []) {
  const root = document.getElementById("directorList");
  if (!root) return;
  if (!directors.length) {
    root.innerHTML = `<article class="empty-state">No directors.</article>`;
    return;
  }
  root.innerHTML = directors
    .map((director) => {
      const totals = director.totals || {};
      return `
        <article class="oversight-card">
          <div>
            <h2>${escapeHTML(director.displayName || director.email || "Director")}</h2>
            <p>${escapeHTML(director.zohoEmail || director.email || "")}</p>
          </div>
          <div class="sync-line">
            <span class="sync-pill ${escapeHTML(director.zohoLastSyncStatus || "never")}">${escapeHTML(syncLabel(director.zohoLastSyncStatus))}</span>
            <span>Last Zoho sync: ${escapeHTML(dateTime(director.zohoLastSyncAt))}</span>
            ${
              director.zohoLastSyncError
                ? `<small>${escapeHTML(director.zohoLastSyncError)}</small>`
                : director.zohoLastSyncSummary
                ? `<small>${escapeHTML(director.zohoLastSyncSummary)}</small>`
                : ""
            }
          </div>
          <dl>
            <div><dt>Records</dt><dd>${Number(totals.totalRecords || 0).toLocaleString()}</dd></div>
            <div><dt>Replies</dt><dd>${Number(totals.founder_attention || 0).toLocaleString()}</dd></div>
            <div><dt>Failed</dt><dd>${Number(totals.follow_up_failed || 0).toLocaleString()}</dd></div>
            <div><dt>Unpaid</dt><dd class="commission-value">${escapeHTML(commissionLabel(totals.commissionOutstanding))}</dd></div>
          </dl>
        </article>
      `;
    })
    .join("");
}

function recordRow(record = {}, { audit = false } = {}) {
  const failed = record.stage === "follow_up_failed";
  return `
    <tr>
      <td data-label="Director">${escapeHTML(record.directorEmail || "—")}</td>
      <td data-label="Attorney">${escapeHTML(record.attorneyName || "—")}<br><span>${escapeHTML(record.attorneyEmail || "")}</span></td>
      <td data-label="State">${escapeHTML(record.state || "—")}</td>
      <td data-label="Stage"><span class="badge${failed ? " danger" : ""}">${escapeHTML(record.stageLabel || record.stage || "—")}</span></td>
      <td data-label="Reply">${date(record.lastReplyAt)}</td>
      <td data-label="Follow-Up">${date(record.followUpSentAt)}${record.lastFollowUpError ? `<br><span>${escapeHTML(record.lastFollowUpError)}</span>` : ""}</td>
      <td data-label="Commission" class="commission-value">${escapeHTML(commissionLabel(record))}<br>${payoutBadge(record)}</td>
      <td data-label="Audit">${audit ? `<button type="button" class="text-btn" data-audit-id="${escapeHTML(record.id)}">Audit</button>` : ""}</td>
    </tr>
  `;
}

function payableRow(record = {}) {
  const payment = record.commissionPayments, legacy = payment?.legacyState === "needs_review";
  const canRecord = !payment?.corrupt && (legacy || payment?.state !== "needs_review" && payment?.groups.some(group => group.outstandingCents > 0));
  return `
    <tr>
      <td data-label="Director">${escapeHTML(record.directorEmail || "—")}</td>
      <td data-label="Attorney">${escapeHTML(record.attorneyName || "—")}<br><span>${escapeHTML(record.attorneyEmail || "")}</span></td>
      <td data-label="State">${escapeHTML(record.state || "—")}</td>
      <td data-label="Completed">${escapeHTML(commissionCount(record.commissionableMatterCount))}</td>
      <td data-label="Commission" class="commission-value">${escapeHTML(commissionLabel(record))}</td>
      <td data-label="Payout">
        ${payoutBadge(record)}
        <br>
        <button type="button" class="text-btn" data-payout-id="${escapeHTML(record.id)}" ${canRecord ? "" : "disabled"}>
          ${legacy ? "Review payment" : "Record payment"}
        </button>
      </td>
      <td data-label="Audit"><button type="button" class="text-btn" data-audit-id="${escapeHTML(record.id)}">Audit</button></td>
    </tr>
  `;
}

function renderTable(id, records = [], emptyText = "No records.", opts = {}) {
  const body = document.getElementById(id);
  if (!body) return;
  body.innerHTML = records.length
    ? records.map((record) => recordRow(record, opts)).join("")
    : `<tr class="empty-row"><td colspan="8">${escapeHTML(emptyText)}</td></tr>`;
}

function renderPayables(id, records = [], emptyText = "No commission payables.") {
  const body = document.getElementById(id);
  if (!body) return;
  body.innerHTML = records.length
    ? records.map((record) => payableRow(record)).join("")
    : `<tr class="empty-row"><td colspan="7">${escapeHTML(emptyText)}</td></tr>`;
}

function renderOverview(payload = {}) {
  const directors = payload.directors || [];
  const records = payload.records || [];
  const replies = payload.replies || [];
  const failed = payload.failedFollowUps || [];
  const payables = payload.commissionPayables || [];
  const duplicates = payload.duplicates || [];
  document.getElementById("metricDirectors").textContent = String(directors.length);
  document.getElementById("metricRecords").textContent = String(payload.totalRecords ?? records.length);
  document.getElementById("metricReplies").textContent = String(replies.length);
  document.getElementById("metricFailures").textContent = String(failed.length);
  document.getElementById("metricCommission").textContent = commissionLabel(payload);
  document.getElementById("metricUnpaidCommission").textContent = commissionLabel(payload.commissionOutstanding);
  document.getElementById("metricDuplicates").textContent = String(duplicates.length);

  renderDirectors(directors);
  renderPayables("commissionPayablesBody", payables, "No commission payables.");
  renderTable("replyQueueBody", replies, "No replies.", { audit: true });
  renderTable("failedFollowUpsBody", failed, "No failures.", { audit: true });
  renderTable("duplicateBody", duplicates, "No duplicates.", { audit: true });
  renderTable("recordsBody", records, "No records.", { audit: true });
}


async function loadOverview() {
  const sequence = ++loadSequence;
  setStatus("Loading records…");
  try {
    const res = await secureFetch(financialAccount.url("/api/admin/directors/overview"), { headers: { Accept: "application/json" } });
    const payload = await readJsonOrThrow(res, "Unable to load director oversight.", true);
    if (sequence !== loadSequence) return;
    document.getElementById("downloadCsvBtn").disabled = false;
    renderOverview(payload);
    setStatus("");
  } catch (err) {
    if (sequence === loadSequence) clearFinancialView(err);
  }
}

async function openAudit(recordId, trigger = document.activeElement) {
  const panel = document.getElementById("auditPanel");
  const body = document.getElementById("auditBody");
  if (!panel || !body || !recordId) return;
  const sequence = ++auditSequence, returnFocus = trigger;
  panel.hidden = false;
  panel.removeAttribute("inert");
  if (!panel.open) panel.showModal();
  activateDialogFocus(panel, {
    initialFocus: document.getElementById("closeAuditBtn"),
    returnFocus,
    onEscape: closeAudit,
  });
  body.innerHTML = `<p class="muted">Loading...</p>`;
  try {
    const res = await secureFetch(financialAccount.url(`/api/admin/directors/records/${encodeURIComponent(recordId)}/audit`), {
      headers: { Accept: "application/json" },
    });
    const payload = await readJsonOrThrow(res, "Unable to load commission audit.", true);
    if (sequence !== auditSequence) return;
    const rows = payload.commissionAudit || [];
    body.innerHTML = `
      <h3>${escapeHTML(payload.record?.attorneyName || "Attorney")}</h3>
      <p class="muted">${escapeHTML(payload.record?.attorneyEmail || "")}</p>
      <table>
        <thead><tr><th>Matter</th><th>Status</th><th>Fee evidence</th><th>Attorney Fee</th><th>Director Commission</th></tr></thead>
        <tbody>
          ${
            rows.length
              ? rows
                  .map(
                    (row) => `
                      <tr>
                        <td data-label="Matter">${escapeHTML(row.title || "Matter")}<br><span>${date(row.completedAt || row.createdAt)}</span></td>
                        <td data-label="Status">${escapeHTML(row.status || "—")}</td>
                        <td data-label="Fee evidence">${row.commissionReason === "fully_refunded" ? "Fully refunded · slot restored" : row.commissionState === "needs_review" ? "Needs review" : row.paid ? "Recorded" : "—"}</td>
                        <td data-label="Attorney fee">${escapeHTML(commissionMoney(row.attorneyPlatformFeeCents, row.currency, row.stripeMode, "—"))}</td>
                        <td data-label="Commission">${escapeHTML(commissionMoney(row.directorCommissionCents, row.currency, row.stripeMode, "—"))}</td>
                      </tr>
                    `
                  )
                  .join("")
              : `<tr class="empty-row"><td colspan="5">No matters.</td></tr>`
          }
        </tbody>
      </table>
      ${paymentHistory(payload.record, { controls: true })}
      ${payload.events?.length ? `<h3>Timeline</h3><ul class="timeline">${payload.events
        .map(event => `<li><strong>${escapeHTML(event.eventType)}</strong><span>${date(event.occurredAt)} · ${escapeHTML(event.summary || event.subject || "")}</span></li>`)
        .join("")}</ul>` : ""}
    `;
  } catch (err) {
    if (sequence !== auditSequence) return;
    body.innerHTML = `<p class="muted">${escapeHTML(err?.message || "Unable to load commission audit.")}</p>`;
  }
}

function closeAudit() {
  auditSequence++;
  const panel = document.getElementById("auditPanel");
  if (!panel) return;
  if (panel.open) panel.close();
  panel.hidden = true;
  panel.setAttribute("inert", "");
  deactivateDialogFocus(panel);
}

async function downloadCsv() {
  setStatus("Preparing CSV...");
  try {
    const res = await secureFetch(financialAccount.url("/api/admin/directors/records.csv"), { headers: { Accept: "text/csv" } });
    if (!res.ok) throw new Error("Unable to download CSV.");
    const blob = await res.blob();
    financialAccount.verify();
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "director-outreach-records.csv";
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    setStatus("CSV downloaded.");
  } catch (err) {
    setStatus(err?.message || "Unable to download CSV.");
  }
}

function clearFinancialView(error) {
  for (const element of document.querySelectorAll('[id^="metric"]')) element.textContent = "—";
  document.getElementById("directorList").replaceChildren();
  for (const id of ["commissionPayablesBody", "replyQueueBody", "failedFollowUpsBody", "duplicateBody", "recordsBody"]) {
    document.getElementById(id).innerHTML = '<tr><td colspan="8">Records unavailable. Refresh to try again.</td></tr>';
  }
  document.getElementById("downloadCsvBtn").disabled = true;
  closeAudit(); paymentDialog.clear(); document.getElementById("auditBody").replaceChildren();
  setStatus(error?.message || "Records unavailable. Refresh to try again.");
}
window.addEventListener("storage", () => { try { financialAccount.verify(); } catch (error) { loadSequence++; clearFinancialView(error); } });

document.getElementById("refreshBtn")?.addEventListener("click", loadOverview);
document.getElementById("downloadCsvBtn")?.addEventListener("click", downloadCsv);
document.getElementById("closeAuditBtn")?.addEventListener("click", closeAudit);
document.getElementById("auditPanel")?.addEventListener("cancel", event => { event.preventDefault(); closeAudit(); });
document.getElementById("auditPanel")?.addEventListener("click", (event) => {
  if (event.target === event.currentTarget) closeAudit();
});
document.addEventListener("click", (event) => {
  const button = event.target.closest("[data-audit-id]");
  if (button) openAudit(button.getAttribute("data-audit-id"), button).catch((error) => {
    console.error("[admin-directors] audit detail action rejected", error);
  });
  const payoutButton = event.target.closest("[data-payout-id]"), reverseButton = event.target.closest("[data-payment-reverse]");
  if (payoutButton || reverseButton) {
    const trigger = payoutButton || reverseButton;
    paymentDialog.open(trigger.dataset.payoutId || trigger.dataset.paymentRecord, trigger, reverseButton?.dataset.paymentReverse || "").catch(error => setStatus(error.message));
  }
});

loadOverview().then(() => {
  const recordId = new URLSearchParams(location.search).get("record");
  if (recordId && /^[a-f0-9]{24}$/i.test(recordId)) return openAudit(recordId, document.getElementById("refreshBtn"));
}).catch(error => setStatus(error.message));
