import { requireAuth, secureFetch, logoutUser } from "./auth.js";

requireAuth("admin");

const currency = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

function escapeHTML(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function money(cents) {
  return currency.format((Number(cents) || 0) / 100);
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

function payoutLabel(record = {}) {
  const status = String(record.commissionPayoutStatus || "unpaid").toLowerCase();
  if (status === "paid") return `Paid${record.commissionPaidAt ? ` ${date(record.commissionPaidAt)}` : ""}`;
  return "Unpaid";
}

function payoutBadge(record = {}) {
  const paid = String(record.commissionPayoutStatus || "unpaid").toLowerCase() === "paid";
  return `<span class="badge ${paid ? "success" : "neutral"}">${escapeHTML(payoutLabel(record))}</span>`;
}

async function readJsonOrThrow(res, fallback) {
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(payload?.error || fallback);
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
            <div><dt>Unpaid</dt><dd>${money(totals.commissionUnpaidCents || 0)}</dd></div>
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
      <td data-label="Commission">${money(record.commissionEarnedCents || 0)}<br>${payoutBadge(record)}</td>
      <td data-label="Audit">${audit ? `<button type="button" class="text-btn" data-audit-id="${escapeHTML(record.id)}">Audit</button>` : ""}</td>
    </tr>
  `;
}

function payableRow(record = {}) {
  const paid = String(record.commissionPayoutStatus || "unpaid").toLowerCase() === "paid";
  return `
    <tr>
      <td data-label="Director">${escapeHTML(record.directorEmail || "—")}</td>
      <td data-label="Attorney">${escapeHTML(record.attorneyName || "—")}<br><span>${escapeHTML(record.attorneyEmail || "")}</span></td>
      <td data-label="State">${escapeHTML(record.state || "—")}</td>
      <td data-label="Completed">${Number(record.commissionableMatterCount || 0).toLocaleString()}</td>
      <td data-label="Commission">${money(record.commissionEarnedCents || 0)}</td>
      <td data-label="Payout">
        ${payoutBadge(record)}
        <br>
        <button type="button" class="text-btn" data-payout-id="${escapeHTML(record.id)}" data-paid="${paid ? "false" : "true"}">
          ${paid ? "Mark unpaid" : "Mark paid"}
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
  const commission = records.reduce((sum, record) => sum + Number(record.commissionEarnedCents || 0), 0);
  const unpaidCommission = payables
    .filter((record) => String(record.commissionPayoutStatus || "unpaid").toLowerCase() !== "paid")
    .reduce((sum, record) => sum + Number(record.commissionEarnedCents || 0), 0);

  document.getElementById("metricDirectors").textContent = String(directors.length);
  document.getElementById("metricRecords").textContent = String(records.length);
  document.getElementById("metricReplies").textContent = String(replies.length);
  document.getElementById("metricFailures").textContent = String(failed.length);
  document.getElementById("metricCommission").textContent = money(commission);
  document.getElementById("metricUnpaidCommission").textContent = money(unpaidCommission);
  document.getElementById("metricDuplicates").textContent = String(duplicates.length);

  renderDirectors(directors);
  renderPayables("commissionPayablesBody", payables, "No commission payables.");
  renderTable("replyQueueBody", replies, "No replies.", { audit: true });
  renderTable("failedFollowUpsBody", failed, "No failures.", { audit: true });
  renderTable("duplicateBody", duplicates, "No duplicates.", { audit: true });
  renderTable("recordsBody", records, "No records.", { audit: true });
}

async function updatePayoutStatus(recordId, paid) {
  if (!recordId) return;
  setStatus(paid ? "Marking commission paid..." : "Marking commission unpaid...");
  try {
    const res = await secureFetch(`/api/admin/directors/records/${encodeURIComponent(recordId)}/commission-payout`, {
      method: "PATCH",
      body: { paid },
      headers: { Accept: "application/json" },
    });
    await readJsonOrThrow(res, "Unable to update commission payout.");
    await loadOverview();
    setStatus(paid ? "Commission marked paid." : "Commission marked unpaid.");
  } catch (err) {
    setStatus(err?.message || "Unable to update commission payout.");
  }
}

async function loadOverview() {
  setStatus("");
  try {
    const res = await secureFetch("/api/admin/directors/overview", { headers: { Accept: "application/json" } });
    const payload = await readJsonOrThrow(res, "Unable to load director oversight.");
    renderOverview(payload);
    setStatus("");
  } catch (err) {
    setStatus(err?.message || "Unable to load director oversight.");
  }
}

async function openAudit(recordId) {
  const panel = document.getElementById("auditPanel");
  const body = document.getElementById("auditBody");
  if (!panel || !body || !recordId) return;
  panel.hidden = false;
  body.innerHTML = `<p class="muted">Loading...</p>`;
  try {
    const res = await secureFetch(`/api/admin/directors/records/${encodeURIComponent(recordId)}/audit`, {
      headers: { Accept: "application/json" },
    });
    const payload = await readJsonOrThrow(res, "Unable to load commission audit.");
    const rows = payload.commissionAudit || [];
    body.innerHTML = `
      <h3>${escapeHTML(payload.record?.attorneyName || payload.record?.attorneyEmail || "Attorney")}</h3>
      <p class="muted">${escapeHTML(payload.record?.attorneyEmail || "")}</p>
      <table>
        <thead><tr><th>Matter</th><th>Status</th><th>Paid</th><th>Attorney Fee</th><th>Director Commission</th></tr></thead>
        <tbody>
          ${
            rows.length
              ? rows
                  .map(
                    (row) => `
                      <tr>
                        <td>${escapeHTML(row.title || "Matter")}<br><span>${date(row.completedAt || row.createdAt)}</span></td>
                        <td>${escapeHTML(row.status || "—")}</td>
                        <td>${row.paid ? "Yes" : "No"}</td>
                        <td>${money(row.attorneyPlatformFeeCents || 0)}</td>
                        <td>${money(row.directorCommissionCents || 0)}</td>
                      </tr>
                    `
                  )
                  .join("")
              : `<tr class="empty-row"><td colspan="5">No matters.</td></tr>`
          }
        </tbody>
      </table>
      <h3>Timeline</h3>
      <ul class="timeline">
        ${(payload.events || [])
          .map((event) => `<li><strong>${escapeHTML(event.eventType)}</strong><span>${date(event.occurredAt)} · ${escapeHTML(event.summary || event.subject || "")}</span></li>`)
          .join("") || "<li>No events.</li>"}
      </ul>
    `;
  } catch (err) {
    body.innerHTML = `<p class="muted">${escapeHTML(err?.message || "Unable to load commission audit.")}</p>`;
  }
}

async function downloadCsv() {
  setStatus("Preparing CSV...");
  try {
    const res = await secureFetch("/api/admin/directors/records.csv", { headers: { Accept: "text/csv" } });
    if (!res.ok) throw new Error("Unable to download CSV.");
    const blob = await res.blob();
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

document.getElementById("refreshBtn")?.addEventListener("click", loadOverview);
document.getElementById("downloadCsvBtn")?.addEventListener("click", downloadCsv);
document.getElementById("logoutBtn")?.addEventListener("click", logoutUser);
document.getElementById("closeAuditBtn")?.addEventListener("click", () => {
  const panel = document.getElementById("auditPanel");
  if (panel) panel.hidden = true;
});
document.addEventListener("click", (event) => {
  const button = event.target.closest("[data-audit-id]");
  if (button) openAudit(button.getAttribute("data-audit-id")).catch(() => {});
  const payoutButton = event.target.closest("[data-payout-id]");
  if (payoutButton) {
    const paid = payoutButton.getAttribute("data-paid") === "true";
    updatePayoutStatus(payoutButton.getAttribute("data-payout-id"), paid).catch(() => {});
  }
});

loadOverview();
