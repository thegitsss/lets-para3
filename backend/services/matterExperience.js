const SECTION_DEFINITIONS = Object.freeze([
  { id: "overview", label: "Overview" },
  { id: "applications", label: "Applications" },
  { id: "work", label: "Work" },
  { id: "files", label: "Files" },
  { id: "messages", label: "Messages" },
  { id: "activity", label: "Activity" },
  { id: "financials", label: "Financials" },
]);
const { resolveMatterDeadlineDate } = require("../utils/businessDate");

const asId = (value) => String(value?._id || value?.id || value || "");
const sameId = (left, right) => Boolean(asId(left)) && asId(left) === asId(right);
const finiteCents = (value) => {
  if (value === null || value === undefined || value === "") return null;
  return Number.isFinite(Number(value)) ? Math.max(0, Math.round(Number(value))) : null;
};

function normalizeStatus(value) {
  const status = String(value || "open").trim().toLowerCase().replace(/_/g, " ");
  return status || "open";
}

function statusLabel(value) {
  const status = normalizeStatus(value);
  const labels = {
    open: "Posted",
    "in progress": "In progress",
    paused: "Paused",
    disputed: "Disputed",
    completed: "Completed",
    closed: "Closed",
  };
  return labels[status] || status.replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function cleanSummary(caseDoc) {
  const details = String(caseDoc?.details || "")
    .split(/\n\s*Screening questions:/i)[0]
    .replace(/\s+/g, " ")
    .trim();
  return details || String(caseDoc?.briefSummary || "").replace(/\s+/g, " ").trim();
}

function personName(person, fallback = "") {
  if (!person || typeof person !== "object") return fallback;
  return [person.firstName, person.lastName]
    .map((part) => String(part || "").trim())
    .filter(Boolean)
    .join(" ") || fallback;
}

function applicantId(applicant) {
  return asId(applicant?.paralegalId || applicant?.paralegal);
}

function applicantName(applicant) {
  return (
    personName(applicant?.paralegal) ||
    personName(applicant?.profileSnapshot) ||
    "Paralegal candidate"
  );
}

function applicationItems({ caseDoc, applicants = [], viewer, role, isAttorney }) {
  const viewerId = asId(viewer?.id || viewer?._id);
  const visible = isAttorney
    ? applicants
    : applicants.filter((applicant) => sameId(applicantId(applicant), viewerId));
  const items = visible.map((applicant) => ({
    id: applicantId(applicant),
    name: isAttorney ? applicantName(applicant) : "Your application",
    status: String(applicant?.status || "pending").toLowerCase(),
    appliedAt: applicant?.appliedAt || null,
    preEngagementStatus: applicant?.preEngagement?.status
      ? String(applicant.preEngagement.status).toLowerCase()
      : null,
  }));
  if (isAttorney) {
    const existingIds = new Set(items.map((item) => item.id).filter(Boolean));
    const invites = Array.isArray(caseDoc?.invites) ? caseDoc.invites : [];
    invites.forEach((invite) => {
      const id = asId(invite?.paralegalId);
      const status = String(invite?.status || "pending").toLowerCase();
      if (!id || existingIds.has(id) || !["pending", "accepted"].includes(status)) return;
      items.push({
        id,
        name: personName(invite.paralegalId, "Invited paralegal"),
        status: status === "pending" ? "invited" : "accepted",
        appliedAt: invite?.invitedAt || caseDoc?.pendingParalegalInvitedAt || null,
        preEngagementStatus: null,
      });
      existingIds.add(id);
    });
  }
  if (role === "paralegal" && !items.length) {
    const invites = Array.isArray(caseDoc?.invites) ? caseDoc.invites : [];
    const ownInvite = invites.find(
      (invite) => sameId(invite?.paralegalId, viewerId) && String(invite?.status || "pending").toLowerCase() === "pending"
    );
    if (sameId(caseDoc?.pendingParalegalId, viewerId) || ownInvite) {
      items.push({
        id: viewerId,
        name: "Your invitation",
        status: "invited",
        appliedAt: ownInvite?.invitedAt || caseDoc?.pendingParalegalInvitedAt || null,
        preEngagementStatus: null,
      });
    }
  }
  return items;
}

function ownPreEngagement(caseDoc, viewerId) {
  const preEngagement = caseDoc?.preEngagement;
  if (!preEngagement || !sameId(preEngagement.requestedParalegalId, viewerId)) return null;
  return {
    status: String(preEngagement.status || "requested").toLowerCase(),
    confidentialityAgreementRequired: !!preEngagement.confidentialityAgreementRequired,
    conflictsCheckRequired: !!preEngagement.conflictsCheckRequired,
    requestedAt: preEngagement.requestedAt || null,
    submittedAt: preEngagement.submittedAt || null,
    reviewedAt: preEngagement.reviewedAt || null,
  };
}

function buildActivity(caseDoc, { role, isAttorney, isParalegal, isAdmin, applications, preEngagement }) {
  const items = [];
  const add = (code, label, at) => {
    if (!at) return;
    const date = new Date(at);
    if (Number.isNaN(date.getTime())) return;
    items.push({ code, label, at: date.toISOString() });
  };

  add("posted", "Matter posted", caseDoc?.createdAt);
  if (isAttorney) {
    applications.forEach((application) => add("application", "Application received", application.appliedAt));
  } else if (role === "paralegal") {
    applications.forEach((application) => add("application", "Application submitted", application.appliedAt));
  }
  if (isAttorney || preEngagement) {
    add("preengagement_requested", "Pre-engagement requested", caseDoc?.preEngagement?.requestedAt);
    add("preengagement_submitted", "Pre-engagement submitted", caseDoc?.preEngagement?.submittedAt);
    add("preengagement_reviewed", "Pre-engagement reviewed", caseDoc?.preEngagement?.reviewedAt);
  }
  if (!isAttorney && !isParalegal && !isAdmin) {
    return items
      .sort((left, right) => new Date(right.at).getTime() - new Date(left.at).getTime())
      .slice(0, 10);
  }
  add("started", "Work started", caseDoc?.hiredAt);
  if ((isAttorney || isParalegal) && !isAdmin) {
    (Array.isArray(caseDoc?.files) ? caseDoc.files : []).slice(0, 20).forEach((file) => {
      add("file", "File shared", file?.createdAt || file?.uploadedAt);
    });
  }
  add("paused", "Matter paused", caseDoc?.pausedAt);
  const disputes = Array.isArray(caseDoc?.disputes) ? caseDoc.disputes : [];
  if (disputes.length) add("disputed", "Review opened", disputes[disputes.length - 1]?.createdAt);
  add("payout", "Payout finalized", caseDoc?.payoutFinalizedAt);
  add("relisted", "Matter relisted", caseDoc?.relistRequestedAt);
  add("completed", "Matter completed", caseDoc?.completedAt);

  return items
    .sort((left, right) => new Date(right.at).getTime() - new Date(left.at).getTime())
    .slice(0, 30);
}

function fundingLabel(caseDoc) {
  if (caseDoc?.paymentReleased) return "Released";
  const status = normalizeStatus(caseDoc?.status);
  if (["paused", "disputed"].includes(status)) return "Under review";
  const funding = String(caseDoc?.escrowStatus || "").trim().toLowerCase();
  if (funding === "funded") return "Funded";
  if (["awaiting_funding", "requires_payment_method", "requires_action"].includes(funding)) {
    return "Funding required";
  }
  if (status === "open") return "Not funded";
  return "Payment status unavailable";
}

function buildFinancials(caseDoc, { isAttorney, isParalegal }) {
  if (!isAttorney && !isParalegal) return null;
  const originalGross = finiteCents(caseDoc?.lockedTotalAmount ?? caseDoc?.totalAmount);
  const activeGross = caseDoc?.relistRequestedAt
    ? finiteCents(caseDoc?.remainingAmount) ?? originalGross
    : originalGross;
  const gross = isParalegal ? activeGross : originalGross;
  const currency = String(caseDoc?.currency || "usd").toLowerCase();
  const amounts = [];
  if (gross !== null) amounts.push({ code: "compensation", label: "Matter compensation", cents: gross });

  const settlement = caseDoc?.disputeSettlement || null;
  if (isAttorney) {
    const fee = finiteCents(settlement?.feeAttorneyAmount ?? caseDoc?.feeAttorneyAmount);
    if (fee) amounts.push({ code: "attorney_fee", label: "Attorney platform fee", cents: fee });
  }
  if (isParalegal) {
    const fee = finiteCents(settlement?.feeParalegalAmount ?? caseDoc?.feeParalegalAmount);
    if (fee) amounts.push({ code: "paralegal_fee", label: "Platform fee", cents: fee });
    const settledNet = finiteCents(settlement?.payoutAmount);
    const snapshotNet = caseDoc?.paymentReleased && gross !== null && fee !== null
      ? Math.max(0, gross - fee)
      : null;
    const net = settledNet ?? snapshotNet;
    if (net !== null) {
      amounts.push({
        code: "net",
        label: settledNet !== null ? "Net payout" : "Estimated net",
        cents: net,
      });
    }
  }

  const receiptAvailable = isAttorney
    ? !!(caseDoc?.paymentReleased || caseDoc?.completedAt || caseDoc?.payoutFinalizedAt)
    : !!(caseDoc?.paymentReleased || caseDoc?.payoutFinalizedAt);
  return {
    currency,
    status: fundingLabel(caseDoc),
    amounts,
    receiptHref: receiptAvailable
      ? `/api/payments/receipt/${isAttorney ? "attorney" : "paralegal"}/${encodeURIComponent(asId(caseDoc))}`
      : null,
    note: amounts.length > 1
      ? "Amounts reflect the Matter's saved financial record."
      : "Additional amounts will appear after the financial record is finalized.",
  };
}

function primaryAction(caseDoc, context) {
  const { role, isAttorney, isParalegal, isApplicant, preEngagement, completionPolicy, applications = [] } = context;
  const status = normalizeStatus(caseDoc?.status);
  const tasks = Array.isArray(caseDoc?.tasks) ? caseDoc.tasks : [];
  const tasksComplete = tasks.length > 0 && tasks.every((task) => !!(task?.completed ?? task?.done));
  const nextTask = tasks.find((task) => !(task?.completed ?? task?.done));
  const nextTaskTitle = nextTask
    ? String(nextTask?.title || nextTask?.name || (typeof nextTask === "string" ? nextTask : "")).trim()
    : "";
  const hasAssignedParalegal = Boolean(asId(caseDoc?.paralegal || caseDoc?.paralegalId));

  if (isAttorney) {
    if (caseDoc?.paymentReleased || ["completed", "closed"].includes(status)) {
      return { code: "view_receipt", label: "View financials", tab: "financials" };
    }
    if (tasksComplete && completionPolicy?.ready === true) {
      return { code: "review_completion", label: "Review completion", tab: "work" };
    }
    if (hasAssignedParalegal) {
      return {
        code: nextTaskTitle ? "review_task" : "open_workspace",
        label: nextTaskTitle ? "Review work" : "Open workspace",
        detail: nextTaskTitle || null,
        tab: "work",
      };
    }
    if (status === "open" && applications.length) {
      return {
        code: "review_applications",
        label: "Review applications",
        detail: `${applications.length} application${applications.length === 1 ? "" : "s"} ready for review`,
        tab: "applications",
      };
    }
    return { code: "view_posting", label: "View posting", tab: "overview" };
  }
  if (role === "paralegal" && preEngagement && ["requested", "changes_requested"].includes(preEngagement.status)) {
    return { code: "complete_preengagement", label: "Complete pre-engagement", tab: "applications" };
  }
  if (isParalegal) return { code: "continue_work", label: "Continue work", tab: "work" };
  if (isApplicant) return { code: "view_application", label: "View application", tab: "applications" };
  return { code: "view_overview", label: "View overview", tab: "overview" };
}

function buildMatterExperience(caseDoc, { viewer = {}, acl = {}, applicants = [], policies = {} } = {}) {
  const role = String(viewer?.role || "").toLowerCase();
  const viewerId = asId(viewer?.id || viewer?._id);
  const isAdmin = role === "admin" && !!acl.isAdmin;
  const isAttorney = role === "attorney" && !!acl.isAttorney;
  const isParalegal = role === "paralegal" && !!acl.isParalegal;
  const isApplicant = role === "paralegal" && !!acl.isApplicant;
  const applications = applicationItems({ caseDoc, applicants, viewer, role, isAttorney });
  const preEngagement = ownPreEngagement(caseDoc, viewerId);
  const hasApplicationContext = isAttorney || (!isParalegal && (isApplicant || !!preEngagement || applications.length > 0));
  const workspaceParticipant = !isAdmin && (isAttorney || isParalegal);

  const visibility = {
    overview: true,
    applications: hasApplicationContext,
    work: isAttorney || isParalegal,
    files: workspaceParticipant,
    messages: workspaceParticipant,
    activity: isAdmin || isAttorney || isParalegal || isApplicant,
    financials: isAttorney || isParalegal,
  };
  const sections = SECTION_DEFINITIONS.filter((section) => visibility[section.id]);
  const tasks = (Array.isArray(caseDoc?.tasks) ? caseDoc.tasks : []).map((task) => ({
    title: String(task?.title || task?.name || (typeof task === "string" ? task : "Task")),
    completed: !!(task?.completed ?? task?.done),
  }));
  const completedTasks = tasks.filter((task) => task.completed).length;
  const matterContext = {
    role,
    isAdmin,
    isAttorney,
    isParalegal,
    isApplicant,
    preEngagement,
    completionPolicy: policies.completion || null,
    applications,
  };
  let attention = null;
  const status = normalizeStatus(caseDoc?.status);
  if (status === "disputed") attention = "Review in progress";
  else if (status === "paused") attention = "Matter paused";
  else if (preEngagement && ["requested", "changes_requested"].includes(preEngagement.status)) {
    attention = "Pre-engagement required";
  } else if (policies.completion?.ready === true) attention = "Ready for completion review";
  else if (isAttorney && !asId(caseDoc?.paralegal || caseDoc?.paralegalId) && applications.length) {
    attention = "Applications available";
  }

  return {
    version: 1,
    header: {
      title: String(caseDoc?.title || "Matter"),
      status: { code: normalizeStatus(caseDoc?.status).replace(/\s+/g, "_"), label: statusLabel(caseDoc?.status) },
      practiceArea: String(caseDoc?.practiceArea || ""),
      deadline: resolveMatterDeadlineDate(caseDoc) || null,
      relationship: isAttorney
        ? "Matter owner"
        : isParalegal
          ? "Assigned paralegal"
          : isApplicant
            ? "Applicant"
            : isAdmin
              ? "Administrator"
              : "Authorized viewer",
      attention,
      primaryAction: primaryAction(caseDoc, matterContext),
    },
    sections,
    overview: {
      summary: cleanSummary(caseDoc),
      practiceArea: String(caseDoc?.practiceArea || ""),
      jurisdiction: String(caseDoc?.locationState || caseDoc?.state || ""),
      deadline: resolveMatterDeadlineDate(caseDoc) || null,
      hiredAt: isAttorney || isParalegal ? caseDoc?.hiredAt || null : null,
      attorney: isAttorney || isParalegal || isApplicant ? personName(caseDoc?.attorney, "Attorney") : "",
      paralegal: isAttorney || isParalegal
        ? personName(caseDoc?.paralegal, caseDoc?.paralegalNameSnapshot || "Not assigned")
        : "",
      paralegalId: isAttorney || isParalegal
        ? asId(caseDoc?.paralegal || caseDoc?.paralegalId)
        : "",
      taskProgress: isAttorney || isParalegal
        ? { completed: completedTasks, total: tasks.length }
        : { completed: 0, total: 0 },
    },
    applications: hasApplicationContext
      ? {
          items: applications,
          preEngagement,
          reviewHref: isAttorney
            ? `/dashboard-attorney.html?openApplicants=1&caseId=${encodeURIComponent(asId(caseDoc))}#cases:inquiries`
            : preEngagement
              ? `/dashboard-paralegal.html#cases`
              : null,
        }
      : null,
    work: visibility.work
      ? { tasks, readOnly: !!caseDoc?.readOnly, completed: completedTasks, total: tasks.length }
      : null,
    activity: visibility.activity
      ? buildActivity(caseDoc, { role, isAttorney, isParalegal, isAdmin, applications, preEngagement })
      : [],
    financials: visibility.financials ? buildFinancials(caseDoc, { isAttorney, isParalegal }) : null,
  };
}

module.exports = {
  SECTION_DEFINITIONS,
  buildMatterExperience,
  normalizeStatus,
  statusLabel,
};
