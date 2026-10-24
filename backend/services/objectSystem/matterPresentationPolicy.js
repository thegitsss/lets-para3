const MATTER_STATUS_PRESENTATION = Object.freeze({
  archived: Object.freeze({ label: "Archived", tone: "neutral" }),
  under_administrative_review: Object.freeze({ label: "Administrative review", tone: "danger" }),
  under_dispute_review: Object.freeze({ label: "Dispute review", tone: "danger" }),
  withdrawal_review: Object.freeze({ label: "Withdrawal review", tone: "warning" }),
  relisted_replacement_selection: Object.freeze({ label: "Selecting a replacement", tone: "warning" }),
  paused: Object.freeze({ label: "Paused", tone: "warning" }),
  closed: Object.freeze({ label: "Closed", tone: "neutral" }),
  completed_release_pending: Object.freeze({ label: "Complete · payment pending", tone: "warning" }),
  completed_payment_released: Object.freeze({ label: "Complete · payment released", tone: "success" }),
  in_progress: Object.freeze({ label: "Work in progress", tone: "info" }),
  funding_required: Object.freeze({ label: "Funding attention required", tone: "warning" }),
  selection_in_progress: Object.freeze({ label: "Selection in progress", tone: "info" }),
  open_for_applications: Object.freeze({ label: "Open for applications", tone: "info" }),
});

const MATTER_ATTENTION_PRESENTATION = Object.freeze({
  none: Object.freeze({ label: "No action needed", tone: "success", priority: 0 }),
  paralegal_action: Object.freeze({ label: "Paralegal action needed", tone: "info", priority: 1 }),
  attorney_action: Object.freeze({ label: "Attorney action needed", tone: "warning", priority: 2 }),
  payment_attention: Object.freeze({ label: "Payment attention needed", tone: "warning", priority: 3 }),
  administrative_review: Object.freeze({ label: "Administrative review", tone: "danger", priority: 4 }),
});

function getMatterStatusPresentation(code) {
  return MATTER_STATUS_PRESENTATION[String(code || "")] || null;
}

function getMatterAttentionPresentation(code) {
  return MATTER_ATTENTION_PRESENTATION[String(code || "")] || null;
}

module.exports = Object.freeze({
  MATTER_ATTENTION_PRESENTATION,
  MATTER_STATUS_PRESENTATION,
  getMatterAttentionPresentation,
  getMatterStatusPresentation,
});
