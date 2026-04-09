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

function marketingWorkflowLabel(value = "") {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "linkedin_company_post") return "LinkedIn company post";
  if (normalized === "facebook_page_post") return "Facebook page post";
  if (normalized === "platform_update_announcement") return "Platform update post";
  if (normalized === "founder_linkedin_post") return "Founder LinkedIn post";
  return titleize(value || "draft");
}

function marketingApprovalLabel(value = "") {
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

function uniqueStrings(values = []) {
  return Array.from(
    new Set(
      (Array.isArray(values) ? values : [])
        .map((value) => String(value || "").trim())
        .filter(Boolean)
    )
  );
}

let activePacketId = "";
let activeCycleId = "";
let packetCache = [];
let cycleCache = [];
let linkedInConnection = null;

function buildMarketingPacketWorkKey(packetId = "") {
  const normalizedPacketId = String(packetId || "").trim();
  return normalizedPacketId ? `marketing_draft_packet:${normalizedPacketId}` : "";
}

function renderJrCmoLibrary(library = null) {
  const root = document.getElementById("marketingJrCmoLibrary");
  if (!root) return;
  if (!library) {
    root.innerHTML = `<div class="ai-room-empty">Jr. CMO library not available yet.</div>`;
    return;
  }

  const dayContext = library.dayContext || {};
  const opportunities = Array.isArray(library.opportunities) ? library.opportunities.slice(0, 5) : [];
  const facts = Array.isArray(library.facts) ? library.facts.slice(0, 5) : [];
  const evaluation = library.evaluation || null;
  const signalMeta = library.signalMeta || {};
  const sourceRefs = Array.isArray(dayContext.sourceRefs) ? dayContext.sourceRefs.slice(0, 4) : [];

  const renderSimpleList = (items = [], formatter = (item) => item, empty = "No items recorded.") =>
    items.length
      ? `<ul>${items.map((item) => `<li>${formatter(item)}</li>`).join("")}</ul>`
      : `<p>${escapeHTML(empty)}</p>`;

  root.innerHTML = `
    <section class="ai-room-focus-block">
      <h3>Today's Context</h3>
      <p><span class="ai-room-badge ai-room-badge--${toneClassForStatus(
        dayContext.sourceMode === "hybrid" || dayContext.sourceMode === "external_research" ? "active" : "approved"
      )}">${escapeHTML(titleize(dayContext.sourceMode || "internal_only"))}</span></p>
      <p>${escapeHTML(dayContext.industryClimateSummary || "No day context summary is available yet.")}</p>
      <ul>
        <li>Tone: ${escapeHTML(titleize(String(dayContext.toneRecommendation || "measured").replace(/_/g, " ")))}</li>
        <li>Tone reasoning: ${escapeHTML(dayContext.toneReasoning || "No tone reasoning recorded yet.")}</li>
        <li>Pending review: ${escapeHTML(String(library.pendingReviewCount || 0))}</li>
        <li>Signal mix: support ${escapeHTML(String(signalMeta.supportInsightCount || 0))}, knowledge ${escapeHTML(
          String(signalMeta.knowledgeInsightCount || 0)
        )}, events ${escapeHTML(String(signalMeta.recentEventCount || 0))}</li>
      </ul>
    </section>
    <section class="ai-room-focus-block">
      <h3>Active Signals</h3>
      ${renderSimpleList(
        Array.isArray(dayContext.activeSignals) ? dayContext.activeSignals.slice(0, 6) : [],
        (item) => escapeHTML(item),
        "No active signals are recorded yet."
      )}
    </section>
    <section class="ai-room-focus-block">
      <h3>Active Opportunities</h3>
      ${renderSimpleList(
        opportunities,
        (item) =>
          `${escapeHTML(item.title || "Opportunity")} <span class="small">(${escapeHTML(
            titleize(item.priority || "candidate")
          )} · ${escapeHTML(formatLaneName(item.contentLane || ""))})</span><br><span class="small">${escapeHTML(
            item.rationale || item.summary || ""
          )}</span>`,
        "No Jr. CMO opportunities are active yet."
      )}
    </section>
    <section class="ai-room-focus-block">
      <h3>Approved Support Facts</h3>
      ${renderSimpleList(
        facts,
        (item) =>
          `${escapeHTML(item.title || "Fact")} <span class="small">(${escapeHTML(
            titleize((item.contentLaneHints || []).join(" / "))
          )})</span><br><span class="small">${escapeHTML(item.statement || item.summary || "")}</span>`,
        "No approved support facts are active yet."
      )}
    </section>
    <section class="ai-room-focus-block">
      <h3>Latest Weekly Learning</h3>
      ${
        evaluation
          ? `
            <p>${escapeHTML(evaluation.summary || "Weekly learning is available.")}</p>
            ${renderSimpleList(
              Array.isArray(evaluation.recommendations) ? evaluation.recommendations.slice(0, 5) : [],
              (item) => escapeHTML(item),
              "No weekly recommendations are recorded yet."
            )}
          `
          : "<p>No weekly learning record is available yet.</p>"
      }
    </section>
    <section class="ai-room-focus-block">
      <h3>Source References</h3>
      ${
        sourceRefs.length
          ? `<ul>${sourceRefs
              .map(
                (item) =>
                  `<li>${escapeHTML(item.source || "Source")} · <a href="${escapeHTML(item.url || "#")}" target="_blank" rel="noopener noreferrer">${escapeHTML(
                    item.label || item.url || "Reference"
                  )}</a> <span class="small">${escapeHTML(formatDate(item.publishedAt || ""))}</span></li>`
              )
              .join("")}</ul>`
          : "<p>No external source references are stored for today's context.</p>"
      }
    </section>
  `;
}

async function loadJrCmoLibrary(force = false) {
  const status = document.getElementById("marketingJrCmoStatus");
  if (status && force) status.textContent = "Refreshing Jr. CMO library…";

  try {
    const res = await secureFetch(`/api/admin/marketing/jr-cmo/library${force ? "?refresh=1" : ""}`, {
      headers: { Accept: "application/json" },
    });
    const payload = await readJsonOrThrow(res, "Unable to load Jr. CMO library.");
    renderJrCmoLibrary(payload.library || null);
    if (status) {
      const sourceMode = payload.library?.dayContext?.sourceMode || "internal_only";
      status.textContent = `Jr. CMO library loaded. Source mode: ${titleize(String(sourceMode).replace(/_/g, " "))}.`;
    }
  } catch (err) {
    renderJrCmoLibrary(null);
    if (status) status.textContent = err?.message || "Unable to load Jr. CMO library.";
  }
}

function renderFounderStatusCards(log = null) {
  const compactStatus = log?.compactStatus || {};
  const pendingReviewEl = document.getElementById("marketingFounderPendingReviewCount");
  const readyToPostEl = document.getElementById("marketingFounderReadyToPostCount");
  const blockedEl = document.getElementById("marketingFounderBlockedCount");
  const generatedAtEl = document.getElementById("marketingFounderGeneratedAt");

  if (pendingReviewEl) pendingReviewEl.textContent = String(compactStatus.pendingReviewCount || 0);
  if (readyToPostEl) readyToPostEl.textContent = String(compactStatus.readyToPostCount || 0);
  if (blockedEl) blockedEl.textContent = String(compactStatus.blockedCount || 0);
  if (generatedAtEl) generatedAtEl.textContent = log?.generatedAt ? formatDate(log.generatedAt) : "—";
}

function founderPostToneClass(post = {}) {
  const status = String(post.status || "").toLowerCase();
  if (status.includes("ready to post")) return "healthy";
  if (status.includes("review")) return "needs-review";
  if (status.includes("blocked")) return "blocked";
  if (status.includes("awaiting")) return "active";
  return "active";
}

function renderFounderList(items = [], emptyMessage = "No additional detail is available yet.") {
  const values = Array.isArray(items) ? items.filter(Boolean) : [];
  if (!values.length) return `<p>${escapeHTML(emptyMessage)}</p>`;
  return `<ul>${values.map((item) => `<li>${escapeHTML(item)}</li>`).join("")}</ul>`;
}

function renderFounderActionButton(action = null, variant = "secondary") {
  if (!action) return "";
  const enabled = action.enabled !== false;
  const buttonClass = variant === "primary" ? "btn" : "btn secondary";
  return `<button class="${buttonClass}" type="button"
    data-founder-action-type="${escapeHTML(action.actionType || "")}"
    data-founder-packet-id="${escapeHTML(action.packetId || "")}"
    data-founder-cycle-id="${escapeHTML(action.cycleId || "")}"
    ${enabled ? "" : "disabled"}
  >${escapeHTML(action.label || "Open")}</button>`;
}

function renderFounderDailyLog(log = null) {
  const root = document.getElementById("marketingFounderDailyLog");
  if (!root) return;
  if (!log) {
    root.innerHTML = `<div class="ai-room-empty">Daily summary not available yet.</div>`;
    return;
  }

  root.innerHTML = `
    <section class="ai-room-focus-block">
      <h3>Today’s Summary</h3>
      <p>${escapeHTML(log.summary || "No founder summary is available yet.")}</p>
    </section>
    <section class="ai-room-focus-block">
      <h3>What changed overnight</h3>
      ${renderFounderList(log.whatChanged, "No material marketing change landed overnight.")}
    </section>
    <section class="ai-room-focus-block">
      <h3>What needs Samantha</h3>
      ${renderFounderList(log.needsFounder, "Nothing urgent needs Samantha right now.")}
    </section>
    <section class="ai-room-focus-block">
      <h3>What is blocked</h3>
      ${renderFounderList(log.blockers, "No critical blocker is currently recorded.")}
    </section>
    <section class="ai-room-focus-block">
      <h3>Recommended next steps</h3>
      ${renderFounderList(log.recommendedActions, "No immediate action is required.")}
    </section>
  `;
}

function renderFounderQuickActions(log = null) {
  const root = document.getElementById("marketingFounderQuickActions");
  if (!root) return;
  const quickActions = Array.isArray(log?.quickActions) ? log.quickActions : [];
  if (!quickActions.length) {
    root.innerHTML = `<div class="ai-room-empty">No priority marketing actions are available right now.</div>`;
    return;
  }

  root.innerHTML = quickActions
    .map(
      (action) => `
        <article class="founder-action-item">
          <div class="ai-room-list-item-top">
            <strong class="ai-room-list-item-title">${escapeHTML(action.label || "Action")}</strong>
            <span class="ai-room-badge ai-room-badge--${action.enabled === false ? "blocked" : "active"}">${escapeHTML(
              action.enabled === false ? "Blocked" : "Available"
            )}</span>
          </div>
          <p>${escapeHTML(action.description || "No action description is available.")}</p>
          ${
            action.enabled === false && action.disabledReason
              ? `<p class="small">${escapeHTML(action.disabledReason)}</p>`
              : ""
          }
          <div class="workspace-form-actions">
            ${renderFounderActionButton(action, "primary")}
          </div>
        </article>
      `
    )
    .join("");
}

function renderFounderReadyPosts(log = null) {
  const root = document.getElementById("marketingFounderReadyPosts");
  if (!root) return;
  const readyPosts = Array.isArray(log?.readyPosts) ? log.readyPosts : [];
  if (!readyPosts.length) {
    root.innerHTML = `<div class="ai-room-empty">No review-ready post is available yet for today.</div>`;
    return;
  }

  root.innerHTML = readyPosts
    .map(
      (post) => `
        <article class="founder-ready-card">
          <div class="ai-room-list-item-top">
            <strong class="ai-room-list-item-title">${escapeHTML(post.channelLabel || "Channel")}</strong>
            <span class="ai-room-badge ai-room-badge--${founderPostToneClass(post)}">${escapeHTML(post.status || "Unknown")}</span>
          </div>
          <p>${escapeHTML(post.summary || "No packet summary is available yet.")}</p>
          <ul>
            <li>Packet: ${escapeHTML(post.title || "No packet available today")}</li>
            <li>Approval: ${escapeHTML(titleize(String(post.approvalState || "not_available").replace(/_/g, " ")))}</li>
            <li>Publish readiness: ${escapeHTML(titleize(String(post.publishReadiness || "not_available").replace(/_/g, " ")))}</li>
            <li>Can Samantha post now: ${escapeHTML(post.canPostNow ? "Yes" : "No")}</li>
          </ul>
          ${
            post.blocker
              ? `<p class="small">${escapeHTML(post.blocker)}</p>`
              : ""
          }
          <div class="workspace-form-actions">
            ${renderFounderActionButton(post.primaryAction, "primary")}
            ${renderFounderActionButton(post.secondaryAction, "secondary")}
          </div>
        </article>
      `
    )
    .join("");
}

function renderFounderDailyLayer(log = null) {
  renderFounderStatusCards(log);
  renderFounderDailyLog(log);
  renderFounderQuickActions(log);
  renderFounderReadyPosts(log);
}

async function loadFounderDailyLog(force = false) {
  const status = document.getElementById("marketingFounderStatus");
  if (status && force) status.textContent = "Refreshing daily summary…";

  try {
    const res = force
      ? await secureFetch("/api/admin/marketing/founder-daily-log/refresh", {
          method: "POST",
          body: {},
          headers: { Accept: "application/json" },
        })
      : await secureFetch("/api/admin/marketing/founder-daily-log", {
          headers: { Accept: "application/json" },
        });
    const payload = await readJsonOrThrow(res, "Unable to load daily summary.");
    renderFounderDailyLayer(payload.log || null);
    if (status) {
      status.textContent = payload.log?.generatedAt
        ? `Daily summary loaded. Generated ${formatDate(payload.log.generatedAt)}.`
        : "Daily summary loaded.";
    }
  } catch (err) {
    renderFounderDailyLayer(null);
    if (status) status.textContent = err?.message || "Unable to load daily summary.";
  }
}

function toneClassForStatus(status = "") {
  if (
    status === "approved" ||
    status === "ready_to_publish" ||
    status === "ready" ||
    status === "connected_validated"
  ) {
    return "healthy";
  }
  if (status === "connected_unvalidated") return "active";
  if (status === "awaiting_approval" || status === "pending_review") return "needs-review";
  if (status === "blocked" || status === "rejected" || status === "skipped" || status === "auth_failed") return "blocked";
  return "active";
}

function formatEnabled(value) {
  return value ? "Enabled" : "Disabled";
}

function formatChannelName(channelKey = "") {
  if (channelKey === "linkedin_company") return "LinkedIn company";
  if (channelKey === "facebook_page") return "Facebook Page";
  return titleize(channelKey || "channel");
}

function formatLaneName(value = "") {
  return value ? titleize(String(value || "").replace(/_/g, " ").replace(/\s+\/\s+/g, " / ")) : "—";
}

function looksLikeSampleOrganizationId(value = "") {
  return String(value || "").trim() === "123456789";
}

function looksLikeSampleOrganizationUrn(value = "") {
  return String(value || "").trim() === "urn:li:organization:123456789";
}

function sanitizeLinkedInHintValue(value = "", type = "", connection = null) {
  const text = String(value || "").trim();
  if (!text) return "";
  const isConnected = Boolean(connection && connection.status && connection.status !== "not_connected");
  if (isConnected) return text;
  if (type === "organizationId" && looksLikeSampleOrganizationId(text)) return "";
  if (type === "organizationUrn" && looksLikeSampleOrganizationUrn(text)) return "";
  return text;
}

function formatScopeSnapshot(values = []) {
  const scopes = uniqueStrings(values);
  return scopes.length ? scopes.join(", ") : "Unavailable until a real LinkedIn connection succeeds.";
}

function renderLinkedInConnection(connection = null) {
  linkedInConnection = connection || null;
  const status = document.getElementById("marketingLinkedInConnectionStatus");
  const meta = document.getElementById("marketingLinkedInValidationMeta");
  const facts = document.getElementById("marketingLinkedInConnectionFacts");
  const orgName = document.getElementById("marketingLinkedInOrgName");
  const orgId = document.getElementById("marketingLinkedInOrgId");
  const orgUrn = document.getElementById("marketingLinkedInOrgUrn");
  const apiVersion = document.getElementById("marketingLinkedInApiVersion");

  const normalizedStatus = String(connection?.status || "not_connected").trim() || "not_connected";
  const discoveredCount = Array.isArray(connection?.discoveredOrganizations) ? connection.discoveredOrganizations.length : 0;
  const sanitizedOrgName = String(connection?.organizationName || "").trim();
  const sanitizedOrgId = sanitizeLinkedInHintValue(connection?.organizationId || "", "organizationId", connection);
  const sanitizedOrgUrn = sanitizeLinkedInHintValue(connection?.organizationUrn || "", "organizationUrn", connection);
  const connectionLabel = sanitizedOrgName || sanitizedOrgUrn || sanitizedOrgId || "Unavailable until LinkedIn confirms the company identity.";

  if (orgName) orgName.value = sanitizedOrgName;
  if (orgId) orgId.value = sanitizedOrgId;
  if (orgUrn) orgUrn.value = sanitizedOrgUrn;
  if (apiVersion) apiVersion.value = connection?.apiVersion || "202503";

  if (status) {
    if (!connection || normalizedStatus === "not_connected") {
      status.textContent = "LinkedIn status: Not connected. Ready to start OAuth when you are.";
    } else {
      status.textContent = `LinkedIn status: ${titleize(normalizedStatus)} · ${connection.lastValidationNote || "No connection note available."}`;
    }
  }
  if (meta) {
    if (!connection || normalizedStatus === "not_connected") {
      meta.textContent =
        "No LinkedIn validation has been recorded yet. Organization ID and URN are optional hints only and may remain blank.";
    } else {
      meta.textContent = `Organization: ${connectionLabel} · Last validation: ${formatDate(connection.lastValidatedAt)} · Authorization: ${
        connection.authorizationGranted ? "Granted" : "Not granted"
      } · Discovered orgs: ${discoveredCount}`;
    }
  }
  if (facts) {
    if (normalizedStatus === "connected_validated") {
      facts.textContent = `Connected org: ${connectionLabel}. Token expiry: ${formatDate(
        connection?.tokenExpiresAt
      )}. Granted scopes: ${formatScopeSnapshot(connection?.scopeSnapshot)}.`;
    } else if (normalizedStatus === "connected_unvalidated") {
      facts.textContent =
        "OAuth completed, but LinkedIn organization authorization is not validated yet. Scope and token timing remain hidden until connection validation succeeds.";
    } else if (normalizedStatus === "blocked" || normalizedStatus === "auth_failed") {
      facts.textContent =
        connection?.lastValidationNote ||
        "LinkedIn is blocked. OAuth or organization authorization must be corrected before the company channel becomes ready.";
    } else {
      facts.textContent =
        "OAuth will populate LinkedIn organization identity, scope, and token timing after a real connection succeeds.";
    }
  }
}

async function fetchLinkedInConnection() {
  const res = await secureFetch("/api/admin/marketing/publishing/channel-connections/linkedin_company", {
    headers: { Accept: "application/json" },
  });
  const payload = await res.json();
  if (!res.ok) throw new Error(payload?.error || "Unable to load LinkedIn connection.");
  return payload.connection;
}

function renderPublishingSummary(overview = {}) {
  const settings = overview.settings || {};
  const cadenceEl = document.getElementById("marketingPublishingCadence");
  const enabledEl = document.getElementById("marketingPublishingEnabled");
  const nextDueEl = document.getElementById("marketingPublishingNextDue");
  const openCyclesEl = document.getElementById("marketingPublishingOpenCycles");
  const readinessEl = document.getElementById("marketingPublishingReadiness");
  const cadenceSummaryEl = document.getElementById("marketingPublishingCadenceSummary");
  const cadenceRecommendationsEl = document.getElementById("marketingPublishingCadenceRecommendations");

  if (cadenceEl) cadenceEl.textContent = titleize(settings.cadenceMode || "manual_only");
  if (enabledEl) enabledEl.textContent = formatEnabled(settings.isEnabled === true);
  if (nextDueEl) nextDueEl.textContent = formatDate(settings.nextDueAt);
  if (openCyclesEl) openCyclesEl.textContent = String(overview.openCycleCount || 0);

  const readinessStatuses = Array.isArray(overview.channelReadiness) ? overview.channelReadiness : [];
  const readinessText = readinessStatuses.length
    ? uniqueStrings(readinessStatuses.map((entry) => titleize(entry.status || ""))).join(" / ")
    : "Not configured";
  if (readinessEl) readinessEl.textContent = readinessText || "Not configured";

  const cadenceGuidance = overview.linkedinCadenceGuidance || {};
  if (cadenceSummaryEl) {
    cadenceSummaryEl.textContent = cadenceGuidance.summary
      ? `${cadenceGuidance.summary} Next suggested lane: ${formatLaneName(cadenceGuidance.suggestedNextLaneLabel || cadenceGuidance.suggestedNextLane)}.`
      : "No LinkedIn guidance is available yet.";
  }
  if (cadenceRecommendationsEl) {
    const recommendations = Array.isArray(cadenceGuidance.recommendations) ? cadenceGuidance.recommendations : [];
    cadenceRecommendationsEl.innerHTML = recommendations.length
      ? recommendations.map((item) => `<li>${escapeHTML(item)}</li>`).join("")
      : "<li>No cadence recommendation is available yet.</li>";
  }

  const enabledChannels = Array.isArray(settings.enabledChannels) ? settings.enabledChannels : [];
  const cadenceMode = document.getElementById("marketingPublishingCadenceMode");
  const timezone = document.getElementById("marketingPublishingTimezone");
  const preferredHour = document.getElementById("marketingPublishingPreferredHour");
  const maxOpenCycles = document.getElementById("marketingPublishingMaxOpenCycles");
  const isEnabled = document.getElementById("marketingPublishingIsEnabled");
  const linkedIn = document.getElementById("marketingPublishingLinkedIn");
  const facebook = document.getElementById("marketingPublishingFacebook");
  const pauseReason = document.getElementById("marketingPublishingPauseReason");

  if (cadenceMode) cadenceMode.value = settings.cadenceMode || "manual_only";
  if (timezone) timezone.value = settings.timezone || "America/New_York";
  if (preferredHour) preferredHour.value = Number(settings.preferredHourLocal ?? 9);
  if (maxOpenCycles) maxOpenCycles.value = Number(settings.maxOpenCycles ?? 1);
  if (isEnabled) isEnabled.checked = settings.isEnabled === true;
  if (linkedIn) linkedIn.checked = enabledChannels.includes("linkedin_company");
  if (facebook) facebook.checked = enabledChannels.includes("facebook_page");
  if (pauseReason) pauseReason.value = settings.pauseReason || "";
}

function renderCycleList(cycles = []) {
  cycleCache = Array.isArray(cycles) ? cycles.slice() : [];
  const root = document.getElementById("marketingCycleList");
  if (!root) return;
  if (!cycleCache.length) {
    root.innerHTML = `<div class="ai-room-empty">No publishing cycles exist yet. Trigger a manual cycle or enable cadence to open the first paired review unit.</div>`;
    return;
  }

  root.innerHTML = cycleCache
    .map((cycle) => {
      const isActive = String(cycle.id) === activeCycleId;
      const channelSummary = Object.values(cycle.channels || {})
        .map((channel) => `${formatChannelName(channel.channelKey)}: ${titleize(channel.status || "")}`)
        .join(" · ");
      return `
        <article class="ai-room-list-item support-list-card${isActive ? " support-list-card--active" : ""}" data-marketing-cycle-id="${escapeHTML(
        cycle.id
      )}" role="button" tabindex="0" aria-pressed="${isActive ? "true" : "false"}">
          <div class="ai-room-list-item-top">
            <strong class="ai-room-list-item-title">${escapeHTML(cycle.cycleLabel || "Publishing cycle")}</strong>
            <span class="ai-room-badge ai-room-badge--${toneClassForStatus(cycle.status)}">${escapeHTML(
        titleize(cycle.status || "")
      )}</span>
          </div>
          <p>${escapeHTML(cycle.statusReason || "Cycle status pending evaluation.")}</p>
          <p class="small">${escapeHTML(formatDate(cycle.dueSlotAt || cycle.createdAt))} · ${escapeHTML(
        channelSummary || "No channel detail available"
      )}</p>
        </article>
      `;
    })
    .join("");
}

function renderCycleDetail(cycle = null) {
  const root = document.getElementById("marketingCycleDetail");
  if (!root) return;
  if (!cycle) {
    root.innerHTML = `<div class="ai-room-empty">Select a cycle after it is created.</div>`;
    return;
  }

  const channelBlocks = Object.values(cycle.channels || {})
    .map((channel) => {
      const taskState = channel.approvalTaskState ? titleize(channel.approvalTaskState) : "—";
      const packetState = channel.packetApprovalState ? titleize(channel.packetApprovalState) : "—";
      return `
        <section class="ai-room-focus-block">
          <h3>${escapeHTML(formatChannelName(channel.channelKey))}</h3>
          <p><span class="ai-room-badge ai-room-badge--${toneClassForStatus(channel.status)}">${escapeHTML(
        titleize(channel.status || "")
      )}</span></p>
          <p>${escapeHTML(channel.reason || "No channel state recorded.")}</p>
          <ul>
            <li>Workflow: ${escapeHTML(titleize(channel.workflowType || "—"))}</li>
            <li>Content lane: ${escapeHTML(formatLaneName(channel.contentLane || ""))}</li>
            <li>Growth objective: ${escapeHTML(channel.growthObjective || "—")}</li>
            <li>Approval task: ${escapeHTML(taskState)}</li>
            <li>Packet approval: ${escapeHTML(packetState)}</li>
            <li>Readiness: ${escapeHTML(titleize(channel.readiness?.status || "not_connected"))}</li>
            <li>Readiness note: ${escapeHTML(channel.readiness?.note || "No readiness note available.")}</li>
          </ul>
          <p class="small">${escapeHTML(channel.whyThisHelpsPageGrowth || "No page-growth rationale recorded yet.")}</p>
          <div class="workspace-form-actions">
            ${
              channel.packetId
                ? `<button class="btn secondary" type="button" data-marketing-open-packet="${escapeHTML(channel.packetId)}">Open Packet</button>`
                : ""
            }
            ${
              channel.packetId && (channel.approvalTaskState === "pending" || channel.packetApprovalState === "pending_review")
                ? `<button class="btn secondary" type="button" data-marketing-open-approvals="${escapeHTML(
                    buildMarketingPacketWorkKey(channel.packetId)
                  )}">Open In Approvals</button>`
                : ""
            }
          </div>
        </section>
      `;
    })
    .join("");

  root.innerHTML = `
    <section class="ai-room-focus-block">
      <h3>Cycle Summary</h3>
      <p>${escapeHTML(cycle.cycleLabel || "Publishing cycle")}</p>
      <p class="small">Status: ${escapeHTML(titleize(cycle.status || ""))} · Trigger: ${escapeHTML(
    titleize(cycle.triggerSource || "")
  )} · Created ${escapeHTML(formatDate(cycle.createdAt))}</p>
      <p>${escapeHTML(cycle.statusReason || "")}</p>
    </section>
    <section class="ai-room-focus-block">
      <h3>Cycle Inputs</h3>
      <ul>
        <li>Audience: ${escapeHTML(cycle.targetAudience || "—")}</li>
        <li>Objective: ${escapeHTML(cycle.objective || "—")}</li>
        <li>Due slot: ${escapeHTML(formatDate(cycle.dueSlotAt))}</li>
        <li>Cadence snapshot: ${escapeHTML(titleize(cycle.settingsSnapshot?.cadenceMode || "manual_only"))}</li>
        <li>Enabled channels: ${escapeHTML(
          (cycle.settingsSnapshot?.enabledChannels || []).map((channel) => formatChannelName(channel)).join(", ") || "—"
        )}</li>
      </ul>
    </section>
    ${channelBlocks}
    <section class="ai-room-focus-block">
      <h3>Workflow Guardrails</h3>
      <ul>
        <li>Approval is not publish.</li>
        <li>LinkedIn company publish is enabled only through explicit publish-now for approved packets.</li>
        <li>Facebook Page publishing remains unavailable in this phase.</li>
      </ul>
      ${
        cycle.status !== "skipped"
          ? `<div class="workspace-form-actions">
              <button class="btn secondary" type="button" data-marketing-skip-cycle="${escapeHTML(cycle.id || "")}">Skip Cycle</button>
            </div>`
          : ""
      }
    </section>
  `;
}

async function fetchCycleDetail(cycleId) {
  const res = await secureFetch(`/api/admin/marketing/publishing/cycles/${encodeURIComponent(cycleId)}`, {
    headers: { Accept: "application/json" },
  });
  const payload = await res.json();
  if (!res.ok) throw new Error(payload?.error || "Unable to load publishing cycle detail.");
  return payload.cycle;
}

async function loadPublishingLoop(force = false) {
  const status = document.getElementById("marketingPublishingStatus");
  if (status && force) status.textContent = "Loading publishing loop…";

  try {
    const [overviewRes, linkedInConnectionRes] = await Promise.all([
      secureFetch("/api/admin/marketing/publishing/overview", {
        headers: { Accept: "application/json" },
      }),
      secureFetch("/api/admin/marketing/publishing/channel-connections/linkedin_company", {
        headers: { Accept: "application/json" },
      }),
    ]);
    const overview = await readJsonOrThrow(overviewRes, "Unable to load publishing loop.");
    const linkedInPayload = await readJsonOrThrow(linkedInConnectionRes, "Unable to load LinkedIn connection.");

    renderPublishingSummary(overview);
    renderLinkedInConnection(linkedInPayload.connection || null);
    renderCycleList(overview.latestCycles || []);

    const cycleId = activeCycleId || overview.latestCycles?.[0]?.id;
    if (cycleId) {
      activeCycleId = String(cycleId);
      try {
        const detail = await fetchCycleDetail(activeCycleId);
        renderCycleDetail(detail);
      } catch {
        renderCycleDetail(null);
      }
    } else {
      renderCycleDetail(null);
    }

    if (status && force) status.textContent = "Publishing loop loaded.";
  } catch (err) {
    activeCycleId = "";
    renderPublishingSummary({ settings: {}, channelReadiness: [], openCycleCount: 0 });
    renderLinkedInConnection(null);
    renderCycleList([]);
    renderCycleDetail(null);
    if (status) status.textContent = err?.message || "Unable to load publishing loop.";
  }
}

function renderCounts(counts = {}) {
  const briefCount = document.getElementById("marketingBriefCount");
  const packetCount = document.getElementById("marketingPacketCount");
  const pendingCount = document.getElementById("marketingPendingCount");
  const approvedCount = document.getElementById("marketingApprovedCount");
  if (briefCount) briefCount.textContent = String(counts.briefs || 0);
  if (packetCount) packetCount.textContent = String(counts.packets || 0);
  if (pendingCount) pendingCount.textContent = String(counts.pendingReview || 0);
  if (approvedCount) approvedCount.textContent = String(counts.approved || 0);
}

function renderPacketList(packets = []) {
  packetCache = Array.isArray(packets) ? packets.slice() : [];
  const root = document.getElementById("marketingPacketList");
  if (!root) return;
  if (!packets.length) {
    root.innerHTML = `<div class="ai-room-empty">No drafts yet. Create a brief to generate the first one.</div>`;
    return;
  }
  root.innerHTML = packets
    .map(
      (packet) => `
        <article class="ai-room-list-item support-list-card${String(packet.id) === activePacketId ? " support-list-card--active" : ""}" data-marketing-packet-id="${escapeHTML(
        packet.id
      )}" role="button" tabindex="0" aria-pressed="${String(packet.id) === activePacketId ? "true" : "false"}">
          <div class="ai-room-list-item-top">
            <strong class="ai-room-list-item-title">${escapeHTML(marketingWorkflowLabel(packet.workflowType || ""))}</strong>
            <span class="ai-room-badge ai-room-badge--${packet.approvalState === "pending_review" ? "needs-review" : packet.approvalState === "approved" ? "healthy" : "active"}">${escapeHTML(
        marketingApprovalLabel(packet.approvalState || "")
      )}</span>
          </div>
          <p>${escapeHTML(packet.packetSummary || "")}</p>
          <p class="small">${escapeHTML(packet.targetAudience || "No audience set")} · ${escapeHTML(
        formatLaneName(packet.contentLane || "")
      )} · v${escapeHTML(packet.packetVersion)}</p>
        </article>
      `
    )
    .join("");
}

function renderPacketDetail(packet = null) {
  const root = document.getElementById("marketingPacketDetail");
  if (!root) return;
  if (!packet) {
    root.innerHTML = `<div class="ai-room-empty">Select a draft to review the text, supporting notes, and posting status.</div>`;
    return;
  }

  const renderList = (title, items = []) => `
    <section class="ai-room-focus-block">
      <h3>${escapeHTML(title)}</h3>
      <ul>${(items || []).map((item) => `<li>${escapeHTML(item)}</li>`).join("")}</ul>
    </section>
  `;

  const renderFacts = (facts = []) => `
    <section class="ai-room-focus-block">
      <h3>Key Facts</h3>
      <ul>${facts
        .map((fact) => `<li>${escapeHTML(fact.title || "")}: ${escapeHTML(fact.statement || fact.summary || "")}</li>`)
        .join("")}</ul>
    </section>
  `;

  const renderPositioningBlocks = (blocks = []) => `
    <section class="ai-room-focus-block">
      <h3>Key Talking Points</h3>
      ${
        blocks.length
          ? `<ul>${blocks
              .map(
                (block) =>
                  `<li>${escapeHTML(block.title || titleize(block.type || "block"))}: ${escapeHTML(block.statement || "")}</li>`
              )
              .join("")}</ul>`
          : "<p>No approved positioning blocks were recorded.</p>"
      }
    </section>
  `;

  const readiness = packet.publishReadiness || null;
  const publishHistory = Array.isArray(packet.publishHistory) ? packet.publishHistory : [];
  const packetId = String(packet.id || packet._id || "").trim();
  const approvalWorkKey = buildMarketingPacketWorkKey(packetId);
  const decisionBlock =
    packet.approvalState === "pending_review"
      ? `
        <section class="ai-room-focus-block">
            <h3>Needs Review</h3>
          <p>This draft still needs your approval before it can be used.</p>
          <label class="approval-decision-label">Optional note
            <textarea class="approval-decision-note" id="marketingDecisionNote" rows="3" maxlength="2000" placeholder="Optional approval or rejection note"></textarea>
          </label>
          <div class="approval-decision-actions">
            <button class="btn" type="button" data-marketing-approve-packet="${escapeHTML(packetId)}">Approve Draft</button>
            <button class="btn secondary" type="button" data-marketing-reject-packet="${escapeHTML(packetId)}">Reject Draft</button>
            <button class="btn secondary" type="button" data-marketing-open-approvals="${escapeHTML(approvalWorkKey)}">Open In Approvals</button>
          </div>
        </section>
      `
      : packet.approvalState === "rejected"
        ? `
          <section class="ai-room-focus-block">
            <h3>Review Status</h3>
            <p>This draft was rejected and cannot be posted until a new version is generated.</p>
            <div class="approval-decision-actions">
              <button class="btn secondary" type="button" data-marketing-open-approvals="${escapeHTML(approvalWorkKey)}">Open In Approvals</button>
            </div>
          </section>
        `
        : "";
  const readinessBlock = readiness
    ? `
      <section class="ai-room-focus-block">
        <h3>Posting Status</h3>
        <p><span class="ai-room-badge ai-room-badge--${toneClassForStatus(readiness.status)}">${escapeHTML(
        titleize(readiness.status || "")
      )}</span></p>
        <p>${escapeHTML(
          readiness.isReady
            ? "This approved LinkedIn post can be published right now."
            : "Posting is blocked until the items below are cleared."
        )}</p>
        <ul>
          <li>Channel: ${escapeHTML(formatChannelName(readiness.channelKey || packet.channelKey || ""))}</li>
          <li>Connection: ${escapeHTML(titleize(readiness.connection?.status || "not_connected"))}</li>
          <li>Publish text length: ${escapeHTML(String(readiness.publishTextLength || 0))}</li>
          ${
            (readiness.blockers || [])
              .map((blocker) => `<li>${escapeHTML(blocker)}</li>`)
              .join("") || "<li>No blockers recorded.</li>"
          }
        </ul>
        ${
          packet.workflowType === "linkedin_company_post" && packet.channelKey === "linkedin_company"
            ? `<div class="workspace-form-actions">
                <button class="btn secondary" type="button" data-marketing-refresh-readiness="${escapeHTML(packet.id || packet._id || "")}">Refresh Status</button>
                <button class="btn" type="button" data-marketing-publish-now="${escapeHTML(packet.id || packet._id || "")}" ${
                  readiness.isReady ? "" : "disabled"
                }>Publish to LinkedIn Company</button>
              </div>`
            : ""
        }
      </section>
    `
    : "";

  const publishHistoryBlock = `
    <section class="ai-room-focus-block">
      <h3>Posting History</h3>
      ${
        publishHistory.length
          ? `<ul>${publishHistory
              .map(
                (entry) =>
                  `<li>${escapeHTML(titleize(entry.status || ""))} · ${escapeHTML(formatDate(entry.publishedAt || entry.createdAt))} · ${escapeHTML(
                    entry.failureClass ? `${titleize(entry.failureClass)}: ${entry.failureReason || ""}` : entry.providerResourceUrn || "No provider URN recorded."
                  )}</li>`
              )
              .join("")}</ul>`
          : "<p>No LinkedIn posting attempts have been recorded for this draft.</p>"
      }
    </section>
  `;

  root.innerHTML = `
    ${decisionBlock}
    <section class="ai-room-focus-block">
      <h3>Draft Summary</h3>
      <p>${escapeHTML(packet.packetSummary || "")}</p>
      <p class="small">Audience: ${escapeHTML(packet.targetAudience || "—")} · Updated ${escapeHTML(formatDate(packet.updatedAt))}</p>
    </section>
    <section class="ai-room-focus-block">
      <h3>LinkedIn Plan</h3>
      <ul>
        <li>Content lane: ${escapeHTML(formatLaneName(packet.contentLane || packet.channelDraft?.contentLane || ""))}</li>
        <li>Growth objective: ${escapeHTML(packet.growthObjective || packet.channelDraft?.growthObjective || "—")}</li>
        <li>Primary hook: ${escapeHTML(packet.channelDraft?.primaryHook || packet.channelDraft?.openingHook || "—")}</li>
      </ul>
      <p>${escapeHTML(packet.whyThisHelpsPageGrowth || packet.channelDraft?.whyThisHelpsPageGrowth || "No page-growth rationale recorded.")}</p>
    </section>
    ${renderList("Main Points", packet.messageHierarchy || [])}
    ${renderFacts(packet.approvedFactCards || [])}
    ${renderPositioningBlocks(packet.approvedPositioningBlocksUsed || packet.channelDraft?.approvedPositioningBlocksUsed || [])}
    ${renderList("Claims To Avoid", packet.claimsToAvoid || [])}
    <section class="ai-room-focus-block">
      <h3>Draft Content</h3>
      <p>${escapeHTML(packet.channelDraft?.headline || packet.channelDraft?.openingHook || packet.channelDraft?.channel || "")}</p>
      <p style="white-space:pre-wrap;">${escapeHTML(packet.channelDraft?.body || "")}</p>
      <p class="small">CTA: ${escapeHTML(packet.channelDraft?.closingCta || "")}</p>
    </section>
    ${renderList("Alternate Angles", packet.alternateAngles || [])}
    ${renderList("Hook Options", packet.hookOptions || [])}
    ${renderList("Alternate Hooks", packet.channelDraft?.alternateHooks || [])}
    ${renderList("CTA Options", packet.ctaOptions || packet.channelDraft?.followOrientedCtaOptions || [])}
    ${renderList("Voice Notes", packet.founderVoiceNotes || [])}
    ${renderList("Open Questions", packet.openQuestions || [])}
    ${renderList("What Still Needs Approval", packet.whatStillNeedsSamantha || [])}
    ${readinessBlock}
    ${publishHistoryBlock}
  `;
}

async function fetchPacketDetail(packetId) {
  const res = await secureFetch(`/api/admin/marketing/draft-packets/${encodeURIComponent(packetId)}`, {
    headers: { Accept: "application/json" },
  });
  const payload = await res.json();
  if (!res.ok) throw new Error(payload?.error || "Unable to load packet detail.");
  return payload.packet;
}

async function refreshActivePacketDetail() {
  if (!activePacketId) {
    renderPacketDetail(null);
    return;
  }
  try {
    const detail = await fetchPacketDetail(activePacketId);
    renderPacketDetail(detail);
  } catch {
    renderPacketDetail(null);
  }
}

async function loadMarketingDraftQueue(force = false) {
  const status = document.getElementById("marketingFormStatus");
  if (status && force) status.textContent = "Loading marketing…";

  try {
    const [overviewRes, packetsRes] = await Promise.all([
      secureFetch("/api/admin/marketing/overview", { headers: { Accept: "application/json" } }),
      secureFetch("/api/admin/marketing/draft-packets", { headers: { Accept: "application/json" } }),
    ]);
    const overview = await readJsonOrThrow(overviewRes, "Unable to load marketing overview.");
    const packetsPayload = await readJsonOrThrow(packetsRes, "Unable to load marketing packets.");

    renderCounts(overview.counts || {});
    const packets = (packetsPayload.packets || []).map((packet) => ({
      id: String(packet._id),
      workflowType: packet.workflowType,
      packetVersion: packet.packetVersion,
      approvalState: packet.approvalState,
      targetAudience: packet.targetAudience,
      contentLane: packet.contentLane,
      growthObjective: packet.growthObjective,
      whyThisHelpsPageGrowth: packet.whyThisHelpsPageGrowth,
      packetSummary: packet.packetSummary,
      updatedAt: packet.updatedAt,
    }));
    renderPacketList(packets);

    const packetId = activePacketId || packets[0]?.id;
    if (packetId) {
      activePacketId = String(packetId);
      try {
        const detail = await fetchPacketDetail(activePacketId);
        renderPacketDetail(detail);
      } catch {
        renderPacketDetail(null);
      }
    } else {
      renderPacketDetail(null);
    }

    if (status && force) status.textContent = "Marketing loaded.";
  } catch (err) {
    activePacketId = "";
    renderCounts({});
    renderPacketList([]);
    renderPacketDetail(null);
    if (status) status.textContent = err?.message || "Unable to load marketing.";
  }
}

async function createBriefAndPacket(event) {
  event.preventDefault();
  const status = document.getElementById("marketingFormStatus");
  const submitBtn = document.getElementById("marketingGenerateBtn");
  if (submitBtn) submitBtn.disabled = true;
  if (status) status.textContent = "Creating brief and generating draft…";

  try {
    const briefPayload = {
      workflowType: document.getElementById("marketingWorkflowType")?.value || "",
      targetAudience: document.getElementById("marketingTargetAudience")?.value || "",
      title: document.getElementById("marketingTitle")?.value || "",
      objective: document.getElementById("marketingObjective")?.value || "",
      briefSummary: document.getElementById("marketingBriefSummary")?.value || "",
      updateFacts: document.getElementById("marketingUpdateFacts")?.value || "",
      ctaPreference: document.getElementById("marketingCtaPreference")?.value || "",
    };

    const briefRes = await secureFetch("/api/admin/marketing/briefs", {
      method: "POST",
      body: briefPayload,
      headers: { Accept: "application/json" },
    });
    const briefData = await briefRes.json();
    if (!briefRes.ok) throw new Error(briefData?.error || "Unable to create marketing brief.");

    const packetRes = await secureFetch(`/api/admin/marketing/briefs/${encodeURIComponent(briefData.brief._id)}/drafts`, {
      method: "POST",
      body: {},
      headers: { Accept: "application/json" },
    });
    const packetData = await packetRes.json();
    if (!packetRes.ok) throw new Error(packetData?.error || "Unable to generate marketing draft.");

    activePacketId = String(packetData.packet._id);
    if (status) status.textContent = "Draft created and added to the review list.";
    await Promise.allSettled([loadFounderDailyLog(true), loadMarketingDraftQueue(true)]);
  } catch (err) {
    if (status) status.textContent = err?.message || "Unable to create marketing draft.";
  } finally {
    if (submitBtn) submitBtn.disabled = false;
  }
}

async function savePublishingSettings(event) {
  event.preventDefault();
  const status = document.getElementById("marketingPublishingStatus");
  const submitBtn = document.getElementById("marketingPublishingSaveBtn");
  if (submitBtn) submitBtn.disabled = true;
  if (status) status.textContent = "Saving posting settings…";

  try {
    const payload = {
      cadenceMode: document.getElementById("marketingPublishingCadenceMode")?.value || "manual_only",
      timezone: document.getElementById("marketingPublishingTimezone")?.value || "America/New_York",
      preferredHourLocal: Number(document.getElementById("marketingPublishingPreferredHour")?.value || 9),
      maxOpenCycles: Number(document.getElementById("marketingPublishingMaxOpenCycles")?.value || 1),
      isEnabled: document.getElementById("marketingPublishingIsEnabled")?.checked === true,
      enabledChannels: [
        document.getElementById("marketingPublishingLinkedIn")?.checked ? "linkedin_company" : "",
        document.getElementById("marketingPublishingFacebook")?.checked ? "facebook_page" : "",
      ].filter(Boolean),
      pauseReason: document.getElementById("marketingPublishingPauseReason")?.value || "",
    };

    const res = await secureFetch("/api/admin/marketing/publishing/settings", {
      method: "POST",
      body: payload,
      headers: { Accept: "application/json" },
    });
    const response = await res.json();
    if (!res.ok) throw new Error(response?.error || "Unable to save posting settings.");

    if (status) status.textContent = "Posting settings saved.";
    await Promise.allSettled([loadFounderDailyLog(true), loadPublishingLoop(true), loadJrCmoLibrary(true)]);
  } catch (err) {
    if (status) status.textContent = err?.message || "Unable to save posting settings.";
  } finally {
    if (submitBtn) submitBtn.disabled = false;
  }
}

async function saveLinkedInConnection(event) {
  event.preventDefault();
  const status = document.getElementById("marketingLinkedInConnectionStatus");
  const submitBtn = document.getElementById("marketingLinkedInSaveBtn");
  if (submitBtn) submitBtn.disabled = true;
  if (status) status.textContent = "Saving LinkedIn connection…";

  try {
    const payload = {
      isActive: true,
      organizationName: document.getElementById("marketingLinkedInOrgName")?.value || "",
      organizationId: document.getElementById("marketingLinkedInOrgId")?.value || "",
      organizationUrn: document.getElementById("marketingLinkedInOrgUrn")?.value || "",
      apiVersion: document.getElementById("marketingLinkedInApiVersion")?.value || "202503",
    };

    const res = await secureFetch("/api/admin/marketing/publishing/channel-connections/linkedin_company", {
      method: "POST",
      body: payload,
      headers: { Accept: "application/json" },
    });
    const response = await res.json();
    if (!res.ok) throw new Error(response?.error || "Unable to save LinkedIn connection.");

    renderLinkedInConnection(response.connection || null);
    await Promise.allSettled([loadFounderDailyLog(true), loadPublishingLoop(true), refreshActivePacketDetail(), loadJrCmoLibrary(true)]);
    if (status) status.textContent = "LinkedIn connection saved.";
  } catch (err) {
    if (status) status.textContent = err?.message || "Unable to save LinkedIn connection.";
  } finally {
    if (submitBtn) submitBtn.disabled = false;
  }
}

async function startLinkedInOAuth() {
  const status = document.getElementById("marketingLinkedInConnectionStatus");
  const button = document.getElementById("marketingLinkedInConnectBtn");
  if (button) button.disabled = true;
  if (status) status.textContent = "Starting LinkedIn OAuth connection…";

  try {
    const payload = {
      organizationName: document.getElementById("marketingLinkedInOrgName")?.value || "",
      organizationId: document.getElementById("marketingLinkedInOrgId")?.value || "",
      organizationUrn: document.getElementById("marketingLinkedInOrgUrn")?.value || "",
      apiVersion: document.getElementById("marketingLinkedInApiVersion")?.value || "202503",
    };
    const res = await secureFetch("/api/admin/marketing/publishing/channel-connections/linkedin_company/oauth/start", {
      method: "POST",
      body: payload,
      headers: { Accept: "application/json" },
    });
    const response = await res.json();
    if (!res.ok) throw new Error(response?.error || "Unable to start LinkedIn OAuth.");

    const popup = window.open(response.connectUrl, "linkedin-marketing-connect", "width=640,height=760");
    if (!popup) throw new Error("Popup was blocked. Allow popups and try again.");
    if (status) status.textContent = "LinkedIn OAuth window opened.";
  } catch (err) {
    if (status) status.textContent = err?.message || "Unable to start LinkedIn OAuth.";
    if (button) button.disabled = false;
    return;
  }
}

async function validateLinkedInConnectionNow() {
  const status = document.getElementById("marketingLinkedInConnectionStatus");
  const button = document.getElementById("marketingLinkedInValidateBtn");
  if (button) button.disabled = true;
  if (status) status.textContent = "Validating LinkedIn organization authorization…";
  try {
    const res = await secureFetch("/api/admin/marketing/publishing/channel-connections/linkedin_company/validate", {
      method: "POST",
      body: {},
      headers: { Accept: "application/json" },
    });
    const response = await res.json();
    if (!res.ok) throw new Error(response?.error || "Unable to validate LinkedIn connection.");
    renderLinkedInConnection(response.connection || null);
    await Promise.allSettled([loadFounderDailyLog(true), loadPublishingLoop(true), refreshActivePacketDetail(), loadJrCmoLibrary(true)]);
    if (status) status.textContent = response.connection?.lastValidationNote || "LinkedIn validation complete.";
  } catch (err) {
    if (status) status.textContent = err?.message || "Unable to validate LinkedIn connection.";
  } finally {
    if (button) button.disabled = false;
  }
}

async function triggerManualCycle() {
  const status = document.getElementById("marketingPublishingStatus");
  const button = document.getElementById("marketingPublishingManualCycleBtn");
  if (button) button.disabled = true;
  if (status) status.textContent = "Triggering manual publishing cycle…";

  try {
    const res = await secureFetch("/api/admin/marketing/publishing/cycles", {
      method: "POST",
      body: {},
      headers: { Accept: "application/json" },
    });
    const response = await res.json();
    if (!res.ok) throw new Error(response?.error || "Unable to trigger a manual publishing cycle.");

    activeCycleId = response.cycle?.id ? String(response.cycle.id) : activeCycleId;
    activePacketId = response.cycle?.channels?.linkedin_company?.packetId || activePacketId;
    if (status) {
      status.textContent =
        response.created === true
          ? "Manual publishing cycle created."
          : "An open cycle already exists, so no additional cycle was created.";
    }
    await Promise.allSettled([loadFounderDailyLog(true), loadPublishingLoop(true), loadMarketingDraftQueue(true), loadJrCmoLibrary(true)]);
  } catch (err) {
    if (status) status.textContent = err?.message || "Unable to trigger a manual publishing cycle.";
  } finally {
    if (button) button.disabled = false;
  }
}

async function runScheduledCycleCheck() {
  const status = document.getElementById("marketingPublishingStatus");
  const button = document.getElementById("marketingPublishingRunScheduledBtn");
  if (button) button.disabled = true;
  if (status) status.textContent = "Checking for a due publishing slot…";

  try {
    const res = await secureFetch("/api/admin/marketing/publishing/run-scheduled", {
      method: "POST",
      body: {},
      headers: { Accept: "application/json" },
    });
    const response = await res.json();
    if (!res.ok) throw new Error(response?.error || "Unable to run the due-slot check.");

    activeCycleId = response.cycle?.id ? String(response.cycle.id) : activeCycleId;
    if (status) {
      status.textContent =
        response.created === true
          ? "A scheduled publishing cycle was created."
          : `Due-slot check completed: ${titleize(response.reason || "no_change")}.`;
    }
    await Promise.allSettled([loadFounderDailyLog(true), loadPublishingLoop(true), loadMarketingDraftQueue(true), loadJrCmoLibrary(true)]);
  } catch (err) {
    if (status) status.textContent = err?.message || "Unable to run the due-slot check.";
  } finally {
    if (button) button.disabled = false;
  }
}

async function refreshPublishReadiness(packetId = "") {
  if (!packetId) return;
  const status = document.getElementById("marketingFormStatus");
  if (status) status.textContent = "Refreshing posting status…";
  try {
    const res = await secureFetch(`/api/admin/marketing/draft-packets/${encodeURIComponent(packetId)}/publish-readiness`, {
      method: "POST",
      body: {},
      headers: { Accept: "application/json" },
    });
    const payload = await res.json();
    if (!res.ok) throw new Error(payload?.error || "Unable to refresh posting status.");
    await Promise.allSettled([refreshActivePacketDetail(), loadFounderDailyLog(true)]);
    if (status) status.textContent = payload.readiness?.isReady
      ? "Posting status confirmed."
      : "Posting status refreshed with blockers.";
  } catch (err) {
    if (status) status.textContent = err?.message || "Unable to refresh posting status.";
  }
}

async function approvePacket(packetId = "") {
  if (!packetId) return;
  const founderStatus = document.getElementById("marketingFounderStatus");
  const queueStatus = document.getElementById("marketingFormStatus");
  if (!window.confirm("Approve this draft?")) return;
  if (founderStatus) founderStatus.textContent = "Approving draft…";
  if (queueStatus) queueStatus.textContent = "Approving draft…";

  try {
    const res = await secureFetch(`/api/admin/marketing/draft-packets/${encodeURIComponent(packetId)}/approve`, {
      method: "POST",
      body: { note: "Approved from quick actions." },
      headers: { Accept: "application/json" },
    });
    const payload = await readJsonOrThrow(res, "Unable to approve draft.");
    await Promise.allSettled([
      loadFounderDailyLog(true),
      loadMarketingDraftQueue(true),
      loadPublishingLoop(true),
      loadJrCmoLibrary(true),
    ]);
    if (founderStatus) founderStatus.textContent = "Draft approved.";
    if (queueStatus) queueStatus.textContent = `Draft approved: ${payload.packet?.title || "marketing draft"}.`;
  } catch (err) {
    if (founderStatus) founderStatus.textContent = err?.message || "Unable to approve draft.";
    if (queueStatus) queueStatus.textContent = err?.message || "Unable to approve draft.";
  }
}

async function rejectPacket(packetId = "") {
  if (!packetId) return;
  const founderStatus = document.getElementById("marketingFounderStatus");
  const queueStatus = document.getElementById("marketingFormStatus");
  if (!window.confirm("Reject this draft?")) return;
  const note = document.getElementById("marketingDecisionNote")?.value || "";
  if (founderStatus) founderStatus.textContent = "Rejecting draft…";
  if (queueStatus) queueStatus.textContent = "Rejecting draft…";

  try {
    const res = await secureFetch(`/api/admin/marketing/draft-packets/${encodeURIComponent(packetId)}/reject`, {
      method: "POST",
      body: { note },
      headers: { Accept: "application/json" },
    });
    const payload = await readJsonOrThrow(res, "Unable to reject draft.");
    await Promise.allSettled([
      loadFounderDailyLog(true),
      loadMarketingDraftQueue(true),
      loadPublishingLoop(true),
      loadJrCmoLibrary(true),
    ]);
    if (founderStatus) founderStatus.textContent = "Draft rejected.";
    if (queueStatus) queueStatus.textContent = `Draft rejected: ${payload.packet?.title || "marketing draft"}.`;
  } catch (err) {
    if (founderStatus) founderStatus.textContent = err?.message || "Unable to reject draft.";
    if (queueStatus) queueStatus.textContent = err?.message || "Unable to reject draft.";
  }
}

async function publishPacketNow(packetId = "") {
  if (!packetId) return;
  const status = document.getElementById("marketingFormStatus");
  const founderStatus = document.getElementById("marketingFounderStatus");
  if (!window.confirm("Publish this approved LinkedIn post right now?")) return;
  if (status) status.textContent = "Publishing approved LinkedIn post…";
  if (founderStatus) founderStatus.textContent = "Publishing approved LinkedIn post…";

  try {
    const res = await secureFetch(`/api/admin/marketing/draft-packets/${encodeURIComponent(packetId)}/publish-now`, {
      method: "POST",
      body: {},
      headers: { Accept: "application/json" },
    });
    const payload = await res.json();
    if (!res.ok) throw new Error(payload?.error || "Unable to publish draft.");

    await Promise.allSettled([loadFounderDailyLog(true), loadPublishingLoop(true), loadMarketingDraftQueue(true)]);
    const message = payload.intent?.providerResourceUrn
      ? `LinkedIn publish recorded: ${payload.intent.providerResourceUrn}`
      : "LinkedIn post recorded successfully.";
    if (status) status.textContent = message;
    if (founderStatus) founderStatus.textContent = message;
  } catch (err) {
    await Promise.allSettled([loadFounderDailyLog(true), loadPublishingLoop(true), refreshActivePacketDetail()]);
    if (status) status.textContent = err?.message || "Unable to publish draft.";
    if (founderStatus) founderStatus.textContent = err?.message || "Unable to publish draft.";
  }
}

async function skipCycle(cycleId = "") {
  const normalizedCycleId = String(cycleId || "").trim();
  if (!normalizedCycleId) return;
  const status = document.getElementById("marketingPublishingStatus");
  const reason = window.prompt("Optional reason for skipping this cycle:", "") || "";
  if (!window.confirm("Skip this publishing cycle?")) return;
  if (status) status.textContent = "Skipping publishing cycle…";

  try {
    const res = await secureFetch(`/api/admin/marketing/publishing/cycles/${encodeURIComponent(normalizedCycleId)}/skip`, {
      method: "POST",
      body: { reason },
      headers: { Accept: "application/json" },
    });
    await readJsonOrThrow(res, "Unable to skip publishing cycle.");
    await Promise.allSettled([loadFounderDailyLog(true), loadPublishingLoop(true), loadMarketingDraftQueue(true)]);
    if (status) status.textContent = "Publishing cycle skipped.";
  } catch (err) {
    if (status) status.textContent = err?.message || "Unable to skip publishing cycle.";
  }
}

async function openPacketInMarketing(packetId = "") {
  const normalizedPacketId = String(packetId || "").trim();
  if (!normalizedPacketId) return;
  activePacketId = normalizedPacketId;
  renderPacketList(packetCache);
  try {
    const detail = await fetchPacketDetail(activePacketId);
    renderPacketDetail(detail);
  } catch {
    renderPacketDetail(null);
  }
  document.getElementById("marketingPacketDetail")?.scrollIntoView({ behavior: "smooth", block: "start" });
}

async function openFounderPacket(packetId = "", cycleId = "") {
  if (cycleId) {
    activeCycleId = String(cycleId);
    renderCycleList(cycleCache);
    try {
      const cycle = await fetchCycleDetail(activeCycleId);
      renderCycleDetail(cycle);
    } catch {
      renderCycleDetail(null);
    }
  }
  if (packetId) {
    activePacketId = String(packetId);
    renderPacketList(packetCache);
    try {
      const packet = await fetchPacketDetail(activePacketId);
      renderPacketDetail(packet);
    } catch {
      renderPacketDetail(null);
    }
  }

  const target = document.getElementById(packetId ? "marketingPacketDetail" : "marketingFullQueueAnchor");
  target?.scrollIntoView({ behavior: "smooth", block: "start" });
}

function openFullMarketingQueue() {
  document.getElementById("marketingFullQueueAnchor")?.scrollIntoView({ behavior: "smooth", block: "start" });
}

async function runFounderAction(actionType = "", packetId = "", cycleId = "") {
  if (actionType === "publish_packet_now") {
    await publishPacketNow(packetId);
    return;
  }
  if (actionType === "approve_packet") {
    await approvePacket(packetId);
    return;
  }
  if (actionType === "open_packet") {
    await openFounderPacket(packetId, cycleId);
    return;
  }
  if (actionType === "open_marketing_queue") {
    openFullMarketingQueue();
    return;
  }
  if (actionType === "refresh_founder_daily_log") {
    await loadFounderDailyLog(true);
  }
}

function bindMarketingQueue() {
  const form = document.getElementById("marketingBriefForm");
  const refreshBtn = document.getElementById("marketingRefreshBtn");
  const list = document.getElementById("marketingPacketList");
  const publishingForm = document.getElementById("marketingPublishingSettingsForm");
  const publishingRefreshBtn = document.getElementById("marketingPublishingRefreshBtn");
  const jrCmoRefreshBtn = document.getElementById("marketingJrCmoRefreshBtn");
  const founderRefreshBtn = document.getElementById("marketingFounderRefreshBtn");
  const founderOpenQueueBtn = document.getElementById("marketingFounderOpenQueueBtn");
  const founderQuickActions = document.getElementById("marketingFounderQuickActions");
  const founderReadyPosts = document.getElementById("marketingFounderReadyPosts");
  const manualCycleBtn = document.getElementById("marketingPublishingManualCycleBtn");
  const runScheduledBtn = document.getElementById("marketingPublishingRunScheduledBtn");
  const cycleList = document.getElementById("marketingCycleList");
  const linkedInConnectionForm = document.getElementById("marketingLinkedInConnectionForm");
  const linkedInRefreshBtn = document.getElementById("marketingLinkedInRefreshBtn");
  const linkedInConnectBtn = document.getElementById("marketingLinkedInConnectBtn");
  const linkedInValidateBtn = document.getElementById("marketingLinkedInValidateBtn");
  const packetDetail = document.getElementById("marketingPacketDetail");

  if (form && !form.dataset.bound) {
    form.dataset.bound = "true";
    form.addEventListener("submit", createBriefAndPacket);
  }
  if (refreshBtn && !refreshBtn.dataset.bound) {
    refreshBtn.dataset.bound = "true";
    refreshBtn.addEventListener("click", () => loadMarketingDraftQueue(true));
  }
  if (list && !list.dataset.bound) {
    list.dataset.bound = "true";
    const selectPacket = async (event) => {
      const item = event.target.closest("[data-marketing-packet-id]");
      if (!item) return;
      activePacketId = item.getAttribute("data-marketing-packet-id") || "";
      renderPacketList(packetCache);
      try {
        const detail = await fetchPacketDetail(activePacketId);
        renderPacketDetail(detail);
      } catch {
        renderPacketDetail(null);
      }
    };
    list.addEventListener("click", (event) => {
      selectPacket(event).catch(() => {});
    });
    list.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      selectPacket(event).catch(() => {});
    });
  }
  if (publishingForm && !publishingForm.dataset.bound) {
    publishingForm.dataset.bound = "true";
    publishingForm.addEventListener("submit", savePublishingSettings);
  }
  if (publishingRefreshBtn && !publishingRefreshBtn.dataset.bound) {
    publishingRefreshBtn.dataset.bound = "true";
    publishingRefreshBtn.addEventListener("click", () => {
      Promise.allSettled([loadFounderDailyLog(true), loadPublishingLoop(true), loadJrCmoLibrary(true)]).catch(() => {});
    });
  }
  if (jrCmoRefreshBtn && !jrCmoRefreshBtn.dataset.bound) {
    jrCmoRefreshBtn.dataset.bound = "true";
    jrCmoRefreshBtn.addEventListener("click", () => {
      loadJrCmoLibrary(true).catch(() => {});
    });
  }
  if (founderRefreshBtn && !founderRefreshBtn.dataset.bound) {
    founderRefreshBtn.dataset.bound = "true";
    founderRefreshBtn.addEventListener("click", () => {
      loadFounderDailyLog(true).catch(() => {});
    });
  }
  if (founderOpenQueueBtn && !founderOpenQueueBtn.dataset.bound) {
    founderOpenQueueBtn.dataset.bound = "true";
    founderOpenQueueBtn.addEventListener("click", () => {
      openFullMarketingQueue();
    });
  }
  if (founderQuickActions && !founderQuickActions.dataset.bound) {
    founderQuickActions.dataset.bound = "true";
    founderQuickActions.addEventListener("click", (event) => {
      const button = event.target.closest("[data-founder-action-type]");
      if (!button) return;
      runFounderAction(
        button.getAttribute("data-founder-action-type") || "",
        button.getAttribute("data-founder-packet-id") || "",
        button.getAttribute("data-founder-cycle-id") || ""
      ).catch(() => {});
    });
  }
  if (founderReadyPosts && !founderReadyPosts.dataset.bound) {
    founderReadyPosts.dataset.bound = "true";
    founderReadyPosts.addEventListener("click", (event) => {
      const button = event.target.closest("[data-founder-action-type]");
      if (!button) return;
      runFounderAction(
        button.getAttribute("data-founder-action-type") || "",
        button.getAttribute("data-founder-packet-id") || "",
        button.getAttribute("data-founder-cycle-id") || ""
      ).catch(() => {});
    });
  }
  if (manualCycleBtn && !manualCycleBtn.dataset.bound) {
    manualCycleBtn.dataset.bound = "true";
    manualCycleBtn.addEventListener("click", () => {
      triggerManualCycle().catch(() => {});
    });
  }
  if (runScheduledBtn && !runScheduledBtn.dataset.bound) {
    runScheduledBtn.dataset.bound = "true";
    runScheduledBtn.addEventListener("click", () => {
      runScheduledCycleCheck().catch(() => {});
    });
  }
  if (linkedInConnectionForm && !linkedInConnectionForm.dataset.bound) {
    linkedInConnectionForm.dataset.bound = "true";
    linkedInConnectionForm.addEventListener("submit", saveLinkedInConnection);
  }
  if (linkedInRefreshBtn && !linkedInRefreshBtn.dataset.bound) {
    linkedInRefreshBtn.dataset.bound = "true";
    linkedInRefreshBtn.addEventListener("click", () => {
      fetchLinkedInConnection()
        .then((connection) => renderLinkedInConnection(connection))
        .catch(() => {});
    });
  }
  if (linkedInConnectBtn && !linkedInConnectBtn.dataset.bound) {
    linkedInConnectBtn.dataset.bound = "true";
    linkedInConnectBtn.addEventListener("click", () => {
      startLinkedInOAuth().catch(() => {});
    });
  }
  if (linkedInValidateBtn && !linkedInValidateBtn.dataset.bound) {
    linkedInValidateBtn.dataset.bound = "true";
    linkedInValidateBtn.addEventListener("click", () => {
      validateLinkedInConnectionNow().catch(() => {});
    });
  }
  if (cycleList && !cycleList.dataset.bound) {
    cycleList.dataset.bound = "true";
    const selectCycle = async (event) => {
      const item = event.target.closest("[data-marketing-cycle-id]");
      if (!item) return;
      activeCycleId = item.getAttribute("data-marketing-cycle-id") || "";
      renderCycleList(cycleCache);
      try {
        const detail = await fetchCycleDetail(activeCycleId);
        renderCycleDetail(detail);
      } catch {
        renderCycleDetail(null);
      }
    };
    cycleList.addEventListener("click", (event) => {
      selectCycle(event).catch(() => {});
    });
    cycleList.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      selectCycle(event).catch(() => {});
    });
  }
  const cycleDetail = document.getElementById("marketingCycleDetail");
  if (cycleDetail && !cycleDetail.dataset.bound) {
    cycleDetail.dataset.bound = "true";
    cycleDetail.addEventListener("click", (event) => {
      const skipButton = event.target.closest("[data-marketing-skip-cycle]");
      if (skipButton) {
        const cycleId = skipButton.getAttribute("data-marketing-skip-cycle") || "";
        skipCycle(cycleId).catch(() => {});
        return;
      }
      const packetButton = event.target.closest("[data-marketing-open-packet]");
      if (packetButton) {
        const packetId = packetButton.getAttribute("data-marketing-open-packet") || "";
        openPacketInMarketing(packetId).catch(() => {});
        return;
      }
      const approvalButton = event.target.closest("[data-marketing-open-approvals]");
      if (approvalButton) {
        const workKey = approvalButton.getAttribute("data-marketing-open-approvals") || "";
        window.openApprovalWorkspaceItem?.(workKey);
      }
    });
  }
  if (packetDetail && !packetDetail.dataset.bound) {
    packetDetail.dataset.bound = "true";
    packetDetail.addEventListener("click", (event) => {
      const approveButton = event.target.closest("[data-marketing-approve-packet]");
      if (approveButton) {
        const packetId = approveButton.getAttribute("data-marketing-approve-packet") || "";
        approvePacket(packetId).catch(() => {});
        return;
      }
      const rejectButton = event.target.closest("[data-marketing-reject-packet]");
      if (rejectButton) {
        const packetId = rejectButton.getAttribute("data-marketing-reject-packet") || "";
        rejectPacket(packetId).catch(() => {});
        return;
      }
      const approvalButton = event.target.closest("[data-marketing-open-approvals]");
      if (approvalButton) {
        const workKey = approvalButton.getAttribute("data-marketing-open-approvals") || "";
        window.openApprovalWorkspaceItem?.(workKey);
        return;
      }
      const refreshButton = event.target.closest("[data-marketing-refresh-readiness]");
      if (refreshButton) {
        const packetId = refreshButton.getAttribute("data-marketing-refresh-readiness") || "";
        refreshPublishReadiness(packetId).catch(() => {});
        return;
      }
      const publishButton = event.target.closest("[data-marketing-publish-now]");
      if (publishButton) {
        const packetId = publishButton.getAttribute("data-marketing-publish-now") || "";
        publishPacketNow(packetId).catch(() => {});
      }
    });
  }
}

bindMarketingQueue();
window.loadMarketingDraftQueue = loadMarketingDraftQueue;
window.loadMarketingPublishingLoop = loadPublishingLoop;
window.loadMarketingJrCmoLibrary = loadJrCmoLibrary;
window.loadMarketingFounderDailyLog = loadFounderDailyLog;

window.addEventListener("message", (event) => {
  if (event.origin !== window.location.origin) return;
  if (event.data?.type !== "marketing-linkedin-oauth") return;
  const payload = event.data?.payload || {};
  const status = document.getElementById("marketingLinkedInConnectionStatus");
  const button = document.getElementById("marketingLinkedInConnectBtn");
  if (button) button.disabled = false;
  if (payload.connection) {
    renderLinkedInConnection(payload.connection);
  }
  if (status) status.textContent = payload.message || (payload.ok ? "LinkedIn connection completed." : "LinkedIn connection failed.");
  Promise.allSettled([loadFounderDailyLog(true), loadPublishingLoop(true), refreshActivePacketDetail(), loadJrCmoLibrary(true)]).catch(() => {});
});

if (document.getElementById("section-marketing-drafts")?.classList.contains("visible")) {
  loadFounderDailyLog().catch(() => {});
  loadMarketingDraftQueue().catch(() => {});
  loadPublishingLoop().catch(() => {});
  loadJrCmoLibrary().catch(() => {});
}
