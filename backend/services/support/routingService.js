function suggestRouting({
  category = "general_support",
  linkedIncidents = [],
  riskFlags = [],
  requesterRole = "unknown",
} = {}) {
  const flags = new Set((riskFlags || []).map((flag) => String(flag || "").trim()));
  const hasActiveIncident = (linkedIncidents || []).some((incident) => incident.relationType === "active_issue");

  if (flags.has("money_sensitive") || category === "payments_risk" || category === "fees") {
    return {
      ownerKey: "payments",
      priority: "high",
      queueLabel: "Payments review",
      reason: "Payment, fee, or money-sensitive language was detected.",
    };
  }

  if (category === "admissions") {
    return {
      ownerKey: "admissions",
      priority: "normal",
      queueLabel: "Admissions review",
      reason: "Admissions or approval language was detected.",
    };
  }

  if (hasActiveIncident || category === "incident_watch") {
    return {
      ownerKey: "incident_watch",
      priority: "high",
      queueLabel: "Incident watch",
      reason: "A related active incident or advisory is already visible.",
    };
  }

  if (flags.has("founder_review")) {
    return {
      ownerKey: "founder_review",
      priority: "high",
      queueLabel: "Founder review",
      reason: "The message includes refund, dispute, or promise-sensitive language that should stay founder-visible.",
    };
  }

  if (category === "account_access") {
    return {
      ownerKey: "support_ops",
      priority: "high",
      queueLabel: "Account access",
      reason: "Account access or verification language was detected.",
    };
  }

  if (category === "case_workflow" || category === "job_application") {
    return {
      ownerKey: "support_ops",
      priority: requesterRole === "attorney" ? "high" : "normal",
      queueLabel: "Workflow support",
      reason: "The message appears tied to active case, job, or application progress.",
    };
  }

  return {
    ownerKey: "support_ops",
    priority: "normal",
    queueLabel: "General support",
    reason: "No narrower owner lane was required from the visible context.",
  };
}

module.exports = {
  suggestRouting,
};
