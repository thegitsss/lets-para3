function escapeHTML(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatDateTime(value) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString([], {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function renderItems(items = []) {
  if (!items.length) return "<p>No data yet.</p>";
  return `<ul>${items.map((item) => `<li>${escapeHTML(item)}</li>`).join("")}</ul>`;
}

export function renderIncidentDetail(rootId, payload = null) {
  const root = document.getElementById(rootId);
  if (!root) return;

  if (!payload?.incident) {
    root.innerHTML = '<div class="ai-room-empty">Select an incident to inspect its detail.</div>';
    return;
  }

  const incident = payload.incident;
  const latestInvestigation = payload.latestInvestigation;
  const latestPatch = payload.latestPatch;
  const latestVerification = payload.latestVerification;
  const latestRelease = payload.latestRelease;
  const latestReleaseArtifacts = Array.isArray(payload.latestReleaseArtifacts)
    ? payload.latestReleaseArtifacts
    : [];
  const latestApproval = payload.latestApproval;
  const latestNotifications = Array.isArray(payload.latestNotifications) ? payload.latestNotifications : [];

  const facts = [
    `Public ID: ${incident.publicId || "—"}`,
    `State: ${incident.state || "—"}`,
    `Risk: ${incident.classification?.riskLevel || "—"}`,
    `Domain: ${incident.classification?.domain || "—"}`,
    `Surface: ${incident.context?.surface || "—"}`,
    `Route: ${incident.context?.routePath || "—"}`,
    `Cluster: ${incident.classification?.clusterKey || "None"}`,
  ];

  const latestRecords = [
    latestInvestigation
      ? `Investigation #${latestInvestigation.attemptNumber}: ${latestInvestigation.status}`
      : "No investigation record yet.",
    latestPatch ? `Patch #${latestPatch.attemptNumber}: ${latestPatch.status}` : "No patch record yet.",
    latestVerification
      ? `Verification #${latestVerification.attemptNumber}: ${latestVerification.status}`
      : "No verification record yet.",
    latestRelease ? `Release #${latestRelease.attemptNumber}: ${latestRelease.status}` : "No release record yet.",
    latestApproval ? `Approval #${latestApproval.attemptNumber}: ${latestApproval.status}` : "No approval record yet.",
  ];

  const verificationChecks =
    Array.isArray(latestVerification?.requiredChecks) && latestVerification.requiredChecks.length
      ? latestVerification.requiredChecks.map(
          (check) => `${check.key}: ${check.status}${check.details ? ` (${check.details})` : ""}`
        )
      : ["No verification checks recorded yet."];

  const verificationFacts = latestVerification
    ? [
        `Status: ${latestVerification.status || "—"}`,
        `Level: ${latestVerification.verificationLevel || "—"}`,
        `Verifier: ${latestVerification.verifierAgent || "—"}`,
        `Failed checks: ${
          Array.isArray(latestVerification.failedCheckKeys) && latestVerification.failedCheckKeys.length
            ? latestVerification.failedCheckKeys.join(", ")
            : "none"
        }`,
      ]
    : ["No verification record yet."];

  const investigationFacts = latestInvestigation
    ? [
        `Status: ${latestInvestigation.status || "—"}`,
        `Reproduction: ${latestInvestigation.reproductionStatus || "—"}`,
        `Recommended action: ${latestInvestigation.recommendedAction || "—"}`,
        `Confidence: ${latestInvestigation.rootCauseConfidence || "—"}`,
      ]
    : ["No investigation record yet."];

  const investigationTargets = latestInvestigation
    ? [
        ...(Array.isArray(latestInvestigation.suspectedRoutes) && latestInvestigation.suspectedRoutes.length
          ? latestInvestigation.suspectedRoutes.map((route) => `Route: ${route}`)
          : ["Route: none yet"]),
        ...(Array.isArray(latestInvestigation.suspectedFiles) && latestInvestigation.suspectedFiles.length
          ? latestInvestigation.suspectedFiles.slice(0, 4).map((file) => `File: ${file}`)
          : ["File: none yet"]),
      ]
    : ["No suspected routes or files yet."];

  const releaseFacts = latestRelease
    ? [
        `Policy: ${latestRelease.policyDecision || "—"}`,
        `Status: ${latestRelease.status || "—"}`,
        `Preview deploy stage: ${latestRelease.previewDeployStage || "—"}`,
        `Preview deploy: ${latestRelease.previewDeployId || "—"}`,
        `Preview URL: ${latestRelease.previewUrl || "—"}`,
        `Preview commit evidence: ${latestRelease.previewCommitSha || "—"}`,
        `Preview evidence quality: ${latestRelease.previewEvidenceQuality || "—"}`,
        `Preview requested: ${formatDateTime(latestRelease.previewDeployRequestedAt)}`,
        `Preview acknowledged: ${formatDateTime(latestRelease.previewDeployAcknowledgedAt)}`,
        `Preview evidence received: ${formatDateTime(latestRelease.previewEvidenceReceivedAt)}`,
        `Preview prepared: ${formatDateTime(latestRelease.previewPreparedAt)}`,
        `Preview verification: ${latestRelease.previewVerificationStatus || "—"}`,
        `Preview summary: ${latestRelease.previewVerificationSummary || "—"}`,
        `Preview blocking reason: ${latestRelease.previewBlockingReason || "—"}`,
        `Preview verified: ${formatDateTime(latestRelease.previewVerifiedAt)}`,
        `Production deploy stage: ${latestRelease.productionDeployStage || "—"}`,
        `Production deploy: ${latestRelease.productionDeployId || "—"}`,
        `Production commit evidence: ${latestRelease.productionCommitSha || "—"}`,
        `Production evidence quality: ${latestRelease.productionEvidenceQuality || "—"}`,
        `Production requested: ${formatDateTime(latestRelease.productionDeployRequestedAt)}`,
        `Production acknowledged: ${formatDateTime(latestRelease.productionDeployAcknowledgedAt)}`,
        `Production evidence received: ${formatDateTime(latestRelease.productionEvidenceReceivedAt)}`,
        `Production attestation: ${latestRelease.productionAttestationStatus || "—"}`,
        `Production attestation summary: ${latestRelease.productionAttestationSummary || "—"}`,
        `Production blocking reason: ${latestRelease.productionBlockingReason || "—"}`,
        `Production verified to continue: ${formatDateTime(latestRelease.productionVerifiedAt)}`,
        `Deployed: ${formatDateTime(latestRelease.deployedAt)}`,
        `Rollback target: ${latestRelease.rollbackTargetDeployId || "—"}`,
        `Rollback source: ${latestRelease.rollbackTargetSource || "—"}`,
        `Rollback validation: ${latestRelease.rollbackTargetValidationStatus || "—"}`,
        `Rollback validation summary: ${latestRelease.rollbackTargetValidationSummary || "—"}`,
        `Rollback reason: ${latestRelease.rollbackReason || "—"}`,
        `Rollback at: ${formatDateTime(latestRelease.rollbackAt)}`,
        `Smoke: ${latestRelease.smokeStatus || "—"}`,
      ]
    : ["No release record yet."];

  const previewVerificationChecks =
    Array.isArray(latestRelease?.previewVerificationChecks) && latestRelease.previewVerificationChecks.length
      ? latestRelease.previewVerificationChecks.map(
          (check) => `${check.key}: ${check.status}${check.details ? ` (${check.details})` : ""}`
        )
      : ["No preview verification checks recorded yet."];

  const rollbackValidationChecks =
    Array.isArray(latestRelease?.rollbackTargetValidationChecks) &&
    latestRelease.rollbackTargetValidationChecks.length
      ? latestRelease.rollbackTargetValidationChecks.map(
          (check) => `${check.key}: ${check.status}${check.details ? ` (${check.details})` : ""}`
        )
      : ["No rollback target validation checks recorded yet."];

  const productionAttestationChecks =
    Array.isArray(latestRelease?.productionAttestationChecks) &&
    latestRelease.productionAttestationChecks.length
      ? latestRelease.productionAttestationChecks.map(
          (check) => `${check.key}: ${check.status}${check.details ? ` (${check.details})` : ""}`
        )
      : ["No production attestation checks recorded yet."];

  const releaseArtifacts = latestReleaseArtifacts.length
    ? latestReleaseArtifacts.map(
        (artifact) =>
          `${artifact.label || artifact.artifactType}: ${
            artifact.contentType === "link" && artifact.body
              ? String(artifact.body)
              : artifact.artifactType
          }`
      )
    : ["No release artifacts recorded yet."];

  const approvalFacts = latestApproval
    ? [
        `Type: ${latestApproval.approvalType || "—"}`,
        `Status: ${latestApproval.status || "—"}`,
        `Requested: ${formatDateTime(latestApproval.requestedAt)}`,
        `Decided: ${formatDateTime(latestApproval.decidedAt)}`,
        `Decision by: ${latestApproval.decisionByEmail || "—"}`,
        `Decision note: ${latestApproval.decisionNote || "—"}`,
        `Packet artifact: ${latestApproval.packetArtifactId || "—"}`,
      ]
    : ["No approval record yet."];

  const notificationFacts = latestNotifications.length
    ? latestNotifications.map((notification) => {
        const recipient =
          notification.recipientEmail ||
          notification.recipientUserId ||
          notification.audience ||
          "recipient";
        return `${notification.templateKey}: ${notification.status} via ${notification.channel} to ${recipient}`;
      })
    : ["No incident notifications recorded yet."];

  const notificationDetails = latestNotifications.length
    ? latestNotifications.map((notification) => {
        const sentLabel = notification.sentAt ? ` sent ${formatDateTime(notification.sentAt)}` : "";
        return `${notification.bodyPreview || notification.subject || "Notification recorded."}${sentLabel}`;
      })
    : [];

  const approvalControls =
    latestApproval?.status === "pending"
      ? `
        <div class="ai-room-incident-approval-actions">
          <label for="incidentApprovalDecisionNote" class="small">Founder approval note</label>
          <textarea id="incidentApprovalDecisionNote" class="search" rows="3" placeholder="Optional decision note"></textarea>
          <div style="display:flex;gap:.75rem;flex-wrap:wrap;margin-top:.75rem">
            <button class="btn secondary" type="button" data-incident-approval-decision="approve" data-incident-id="${escapeHTML(
              incident.publicId || ""
            )}" data-approval-id="${escapeHTML(latestApproval.id || "")}">Approve Release</button>
            <button class="btn secondary" type="button" data-incident-approval-decision="reject" data-incident-id="${escapeHTML(
              incident.publicId || ""
            )}" data-approval-id="${escapeHTML(latestApproval.id || "")}">Reject Release</button>
          </div>
        </div>
      `
      : "";

  const patchFacts = latestPatch
    ? [
        `Status: ${latestPatch.status || "—"}`,
        `Strategy: ${latestPatch.patchStrategy || "—"}`,
        `Branch: ${latestPatch.gitBranch || "—"}`,
        `Head commit: ${latestPatch.headCommitSha || "—"}`,
      ]
    : ["No patch record yet."];

  const patchTargets = latestPatch
    ? [
        ...(Array.isArray(latestPatch.filesTouched) && latestPatch.filesTouched.length
          ? latestPatch.filesTouched.slice(0, 4).map((file) => `File: ${file}`)
          : ["File: none yet"]),
        ...(Array.isArray(latestPatch.testsModified) && latestPatch.testsModified.length
          ? latestPatch.testsModified.map((file) => `Test updated: ${file}`)
          : []),
        ...(Array.isArray(latestPatch.testsAdded) && latestPatch.testsAdded.length
          ? latestPatch.testsAdded.map((file) => `Test added: ${file}`)
          : []),
      ]
    : ["No patch targets yet."];

  root.innerHTML = `
    <div class="ai-room-focus-body">
      <div class="ai-room-focus-blocks-left">
        <section class="ai-room-focus-block">
          <h3>${escapeHTML(incident.publicId || "Incident detail")}</h3>
          <p>${escapeHTML(incident.summary || "No summary provided.")}</p>
          ${renderItems(facts)}
        </section>
        <section class="ai-room-focus-block">
          <h3>Original Report</h3>
          <p>${escapeHTML(incident.originalReportText || "No original report text recorded.")}</p>
          <p><strong>Created:</strong> ${escapeHTML(formatDateTime(incident.createdAt))}</p>
          <p><strong>Updated:</strong> ${escapeHTML(formatDateTime(incident.updatedAt))}</p>
        </section>
      </div>
      <div class="ai-room-focus-grid">
        <section class="ai-room-focus-block">
          <h3>Latest Records</h3>
          ${renderItems(latestRecords)}
        </section>
        <section class="ai-room-focus-block">
          <h3>Investigation</h3>
          ${renderItems(investigationFacts)}
          ${renderItems(investigationTargets)}
        </section>
        <section class="ai-room-focus-block">
          <h3>Verification</h3>
          <p>${escapeHTML(latestVerification?.summary || "No verification summary yet.")}</p>
          ${renderItems(verificationFacts)}
          ${renderItems(verificationChecks)}
        </section>
        <section class="ai-room-focus-block">
          <h3>Release</h3>
          ${renderItems(releaseFacts)}
          ${renderItems(previewVerificationChecks)}
          ${renderItems(productionAttestationChecks)}
          ${renderItems(rollbackValidationChecks)}
          ${renderItems(releaseArtifacts)}
        </section>
        <section class="ai-room-focus-block">
          <h3>Approval</h3>
          ${renderItems(approvalFacts)}
          ${approvalControls}
        </section>
        <section class="ai-room-focus-block">
          <h3>Notifications</h3>
          ${renderItems(notificationFacts)}
          ${renderItems(notificationDetails)}
        </section>
        <section class="ai-room-focus-block">
          <h3>Root Cause / Patch</h3>
          <p>${escapeHTML(latestInvestigation?.rootCauseSummary || "No investigation summary yet.")}</p>
          <p>${escapeHTML(latestPatch?.patchSummary || "No patch summary yet.")}</p>
          ${renderItems(patchFacts)}
          ${renderItems(patchTargets)}
        </section>
      </div>
    </div>
  `;
}
