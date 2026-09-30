const { openMatter } = require("./accountApplicationProjections");
const SECTION_DEFINITIONS = Object.freeze([
  { id: "overview", label: "Overview" },
  { id: "applications", label: "Applications" },
  { id: "work", label: "Work" },
  { id: "files", label: "Files" },
  { id: "messages", label: "Messages" },
  { id: "deadlines", label: "Deadlines" },
  { id: "activity", label: "Activity" },
  { id: "financials", label: "Financials" },
]);
const { resolveMatterDeadlineDate } = require("../utils/businessDate");

const asId = (value) => String(value?._id || value?.id || value || "");
const sameId = (left, right) => Boolean(asId(left)) && asId(left) === asId(right);


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
    add("preengagement_requested", "Information requested before hiring", caseDoc?.preEngagement?.requestedAt);
    add("preengagement_submitted", "Requested information submitted", caseDoc?.preEngagement?.submittedAt);
    add("preengagement_reviewed", "Requested information reviewed", caseDoc?.preEngagement?.reviewedAt);
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

function buildDisputeAction(caseDoc, { isParalegal }) {
  if (!isParalegal) return null;
  const blockers = [];
  const status = normalizeStatus(caseDoc?.status);
  if (!["in progress", "paused", "completed"].includes(status)) blockers.push("funded_work_required");
  if (!caseDoc?.escrowIntentId || String(caseDoc?.escrowStatus || "").toLowerCase() !== "funded") {
    blockers.push("funded_work_required");
  }
  if (["claimed", "needs_reconciliation"].includes(String(caseDoc?.completionClaimStatus || "").toLowerCase())) {
    blockers.push("completion_in_progress");
  }
  if ((Array.isArray(caseDoc?.disputes) ? caseDoc.disputes : []).some(
    (dispute) => String(dispute?.status || "open").toLowerCase() === "open"
  )) {
    blockers.push("open_dispute");
  }
  return {
    allowed: blockers.length === 0,
    blockers: [...new Set(blockers)],
  };
}

function primaryAction(caseDoc, context) {
  const { role, isAttorney, isParalegal, isApplicant, preEngagement, completionPolicy, pendingApplicationCount = 0 } = context;
  const status = normalizeStatus(caseDoc?.status);
  const tasks = Array.isArray(caseDoc?.tasks) ? caseDoc.tasks : [];
  const tasksComplete = tasks.length > 0 && tasks.every((task) => !!(task?.completed ?? task?.done));
  const nextTask = tasks.find((task) => !(task?.completed ?? task?.done));
  const nextTaskTitle = nextTask
    ? String(nextTask?.title || nextTask?.name || (typeof nextTask === "string" ? nextTask : "")).trim()
    : "";
  const hasAssignedParalegal = Boolean(asId(caseDoc?.paralegal || caseDoc?.paralegalId));

  if (isParalegal && (caseDoc?.archived || ["completed", "closed", "cancelled", "canceled", "expired"].includes(status))) {
    return { code: "view_financials", label: "View financials", tab: "financials" };
  }
  if (isParalegal && ["paused", "disputed"].includes(status)) {
    return { code: "view_activity", label: "View Matter status", tab: "activity" };
  }

  if (isAttorney) {
    if (caseDoc?.paymentReleased || ["completed", "closed"].includes(status)) {
      return { code: "view_receipt", label: "View payments", tab: "financials" };
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
    if (status === "open" && pendingApplicationCount) {
      return {
        code: "review_applications",
        label: "Review applications",
        detail: `${pendingApplicationCount} application${pendingApplicationCount === 1 ? "" : "s"} ready for review`,
        tab: "applications",
      };
    }
    return { code: "view_posting", label: "View posting", tab: "overview" };
  }
  if (role === "paralegal" && preEngagement && ["requested", "changes_requested"].includes(preEngagement.status)) {
    return { code: "complete_preengagement", label: "Provide requested information", tab: "applications" };
  }
  if (isParalegal) return { code: "continue_work", label: "Continue work", tab: "work" };
  if (isApplicant) return { code: "view_application", label: "View application", tab: "applications" };
  return { code: "view_overview", label: "View overview", tab: "overview" };
}

function buildMatterExperience(caseDoc, { viewer = {}, acl = {}, applicants = [], pendingApplicationCount, policies = {}, financials = null } = {}) {
  const role = String(viewer?.role || "").toLowerCase();
  const viewerId = asId(viewer?.id || viewer?._id);
  const isAdmin = role === "admin" && !!acl.isAdmin;
  const isAttorney = role === "attorney" && !!acl.isAttorney;
  const isParalegal = role === "paralegal" && !!acl.isParalegal;
  const isApplicant = role === "paralegal" && !!acl.isApplicant;
  const applications = applicationItems({ caseDoc, applicants, viewer, role, isAttorney });
  const pendingCount = Number.isSafeInteger(pendingApplicationCount) && pendingApplicationCount >= 0
    ? pendingApplicationCount
    : openMatter(caseDoc) ? applications.filter(item => ["pending", "submitted", "viewed", "shortlisted"].includes(item.status)).length : 0;
  const preEngagement = ownPreEngagement(caseDoc, viewerId);
  const hasApplicationContext = isAttorney || (!isParalegal && (isApplicant || !!preEngagement || applications.length > 0));
  const workspaceParticipant = !isAdmin && (isAttorney || isParalegal);

  const visibility = {
    overview: true,
    applications: hasApplicationContext,
    work: isAttorney || isParalegal,
    files: workspaceParticipant,
    messages: workspaceParticipant,
    deadlines: workspaceParticipant,
    activity: isAdmin || isAttorney || isParalegal || isApplicant,
    financials: isAttorney || isParalegal,
  };
  const sections = SECTION_DEFINITIONS.filter((section) => visibility[section.id]);
  const tasks = (Array.isArray(caseDoc?.tasks) ? caseDoc.tasks : []).map((task) => ({
    title: String(task?.title || task?.name || (typeof task === "string" ? task : "Task")),
    completed: !!(task?.completed ?? task?.done),
  }));
  const completedTasks = tasks.filter((task) => task.completed).length;
  const withdrawalPolicy = isParalegal && policies.withdrawal
    ? {
        allowed: policies.withdrawal.allowed === true,
        blockers: Array.isArray(policies.withdrawal.blockers)
          ? policies.withdrawal.blockers.map(String)
          : [],
        completedTaskCount: Math.max(0, Number(policies.withdrawal.facts?.completedTaskCount) || 0),
        totalTaskCount: Math.max(0, Number(policies.withdrawal.facts?.totalTaskCount) || 0),
        outcomeRequiresReview: policies.withdrawal.facts?.outcomeRequiresReview === true,
      }
    : null;
  const matterContext = {
    role,
    isAdmin,
    isAttorney,
    isParalegal,
    isApplicant,
    preEngagement,
    completionPolicy: policies.completion || null,
    applications,
    pendingApplicationCount: pendingCount,
  };
  let attention = null;
  const status = normalizeStatus(caseDoc?.status);
  if (status === "disputed") attention = "Review in progress";
  else if (status === "paused") attention = "Matter paused";
  else if (preEngagement && ["requested", "changes_requested"].includes(preEngagement.status)) {
    attention = "Information needed before hiring";
  } else if (policies.completion?.ready === true) attention = "Ready for completion review";
  else if (isAttorney && pendingCount) {
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
              : null,
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
          pendingCount,
          preEngagement,
          reviewHref: isAttorney
            ? `/dashboard-attorney.html?openApplicants=1&caseId=${encodeURIComponent(asId(caseDoc))}#cases:inquiries`
            : preEngagement
              ? `/dashboard-paralegal.html#cases`
              : null,
        }
      : null,
    work: visibility.work
      ? {
          tasks,
          readOnly: !!caseDoc?.readOnly,
          completed: completedTasks,
          total: tasks.length,
          withdrawal: withdrawalPolicy,
          dispute: buildDisputeAction(caseDoc, { isParalegal }),
        }
      : null,
    activity: visibility.activity
      ? buildActivity(caseDoc, { role, isAttorney, isParalegal, isAdmin, applications, preEngagement })
      : [],
    financials: visibility.financials ? financials || { currency: null, status: "Payment details unavailable", amounts: [], receiptHref: null, note: "Refresh the Matter to check its payment details." } : null,
  };
}

module.exports = {
  SECTION_DEFINITIONS,
  buildMatterExperience,
  normalizeStatus,
  statusLabel,
};
