const path = require("path");
const mongoose = require("mongoose");

const AutonomousAction = require("../../models/AutonomousAction");

const ACTION_THRESHOLDS = Object.freeze({
  ticket_reopened: 0.85,
  ticket_escalated: 0.85,
  incident_routed_from_support: 0.9,
  faq_candidate_created: 0.8,
  support_insight_created: 0.8,
  ticket_resolved: 0.95,
  support_governed_content_auto_approved: 0.9,
  marketing_publish_auto_approved: 0.9,
  sales_outreach_auto_approved: 0.9,
  incident_approval_auto_approved: 0.95,
});

const DISQUALIFIER_KEYS = Object.freeze([
  "involvesPayment",
  "involvesPayout",
  "involvesBillingPromise",
  "legalOrDisputeContext",
]);

function createError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) && !(value instanceof Date);
}

function compactText(value = "", max = 4000) {
  return String(value || "").trim().slice(0, max);
}

function normalizeConfidenceScore(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0 || numeric > 1) {
    throw createError("confidenceScore must be a number between 0 and 1.");
  }
  return numeric;
}

function normalizeObject(value, fieldName, { allowEmpty = true } = {}) {
  if (!isPlainObject(value)) {
    throw createError(`${fieldName} must be an object.`);
  }
  if (!allowEmpty && !Object.keys(value).length) {
    throw createError(`${fieldName} must not be empty.`);
  }
  return value;
}

function normalizeObjectId(value, fieldName) {
  if (!mongoose.isValidObjectId(value)) {
    throw createError(`${fieldName} must be a valid ObjectId.`);
  }
  return new mongoose.Types.ObjectId(String(value));
}

function normalizeDisqualifierFlags(payload = {}) {
  const source = payload?.safetyContext || payload?.contextFlags || payload?.disqualifiers || {};
  if (!isPlainObject(source)) {
    return {};
  }

  return DISQUALIFIER_KEYS.reduce((accumulator, key) => {
    accumulator[key] = source[key] === true;
    return accumulator;
  }, {});
}

function assertNoDisqualifiers(payload = {}) {
  const flags = normalizeDisqualifierFlags(payload);
  const triggered = DISQUALIFIER_KEYS.filter((key) => flags[key] === true);
  if (!triggered.length) return;

  throw createError(
    `Autonomous support actions cannot involve payments, payouts, billing promises, or disputes. Blocked flags: ${triggered.join(", ")}.`
  );
}

function flattenObject(value = {}, prefix = "", result = {}) {
  if (!isPlainObject(value)) {
    return result;
  }

  Object.entries(value).forEach(([key, nestedValue]) => {
    const pathKey = prefix ? `${prefix}.${key}` : key;
    if (isPlainObject(nestedValue)) {
      flattenObject(nestedValue, pathKey, result);
      return;
    }
    result[pathKey] = nestedValue;
  });

  return result;
}

function assertModelNameSafe(modelName = "") {
  if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(String(modelName || "").trim())) {
    throw createError("targetModel must be a valid model name.");
  }
}

function getTargetModel(targetModel = "") {
  const normalized = String(targetModel || "").trim();
  assertModelNameSafe(normalized);

  if (mongoose.models[normalized]) {
    return mongoose.models[normalized];
  }

  try {
    return require(path.join(__dirname, "../../models", `${normalized}.js`));
  } catch (error) {
    throw createError(`Unsupported targetModel: ${normalized}.`);
  }
}

async function assertTargetExists(targetModel = "", targetId = null) {
  const Model = getTargetModel(targetModel);
  const target = await Model.findById(targetId).select("_id").lean();
  if (!target) {
    throw createError("Target document not found.", 404);
  }
  return Model;
}

function validatePayload(payload = {}) {
  const actionType = compactText(payload.actionType, 120);
  const minimumConfidence = ACTION_THRESHOLDS[actionType];
  if (!minimumConfidence) {
    throw createError("Unsupported actionType.");
  }

  const agentRole = compactText(payload.agentRole, 40);
  if (!["CCO", "CMO", "CSO", "CTO"].includes(agentRole)) {
    throw createError("agentRole must be one of CCO, CMO, CSO, or CTO.");
  }

  return {
    agentRole,
    actionType,
    confidenceScore: normalizeConfidenceScore(payload.confidenceScore),
    confidenceReason: compactText(payload.confidenceReason, 4000),
    targetModel: compactText(payload.targetModel, 120),
    targetId: normalizeObjectId(payload.targetId, "targetId"),
    changedFields: normalizeObject(payload.changedFields, "changedFields", { allowEmpty: false }),
    previousValues: normalizeObject(payload.previousValues, "previousValues"),
    actionTaken: compactText(payload.actionTaken, 4000),
    minimumConfidence,
  };
}

async function logAction(payload = {}) {
  assertNoDisqualifiers(payload);
  const validated = validatePayload(payload);

  if (!validated.confidenceReason) {
    throw createError("confidenceReason is required.");
  }
  if (!validated.actionTaken) {
    throw createError("actionTaken is required.");
  }
  if (validated.confidenceScore < validated.minimumConfidence) {
    throw createError(
      `confidenceScore ${validated.confidenceScore} is below the minimum threshold ${validated.minimumConfidence} for ${validated.actionType}.`
    );
  }

  await assertTargetExists(validated.targetModel, validated.targetId);

  return AutonomousAction.create({
    agentRole: validated.agentRole,
    actionType: validated.actionType,
    confidenceScore: validated.confidenceScore,
    confidenceReason: validated.confidenceReason,
    targetModel: validated.targetModel,
    targetId: validated.targetId,
    changedFields: validated.changedFields,
    previousValues: validated.previousValues,
    actionTaken: validated.actionTaken,
  });
}

async function undoAction(actionId) {
  const normalizedActionId = normalizeObjectId(actionId, "actionId");
  const action = await AutonomousAction.findById(normalizedActionId);
  if (!action) {
    throw createError("AutonomousAction not found.", 404);
  }
  if (action.status !== "completed") {
    throw createError("AutonomousAction has already been undone.", 409);
  }

  const Model = getTargetModel(action.targetModel);
  const target = await Model.findById(action.targetId);
  if (!target) {
    throw createError("Target document not found.", 404);
  }

  const changedPaths = flattenObject(action.changedFields || {});
  const previousPaths = flattenObject(action.previousValues || {});
  const pathKeys = Object.keys(changedPaths);
  if (!pathKeys.length) {
    throw createError("AutonomousAction has no restorable field paths.");
  }

  pathKeys.forEach((pathKey) => {
    if (Object.prototype.hasOwnProperty.call(previousPaths, pathKey)) {
      target.set(pathKey, previousPaths[pathKey]);
    } else {
      target.set(pathKey, undefined);
    }
    target.markModified(pathKey);
  });

  await target.save();

  action.status = "undone";
  action.undoneAt = new Date();
  await action.save();

  return target;
}

async function getRecentActions(limit = 50) {
  const safeLimit = Math.min(100, Math.max(1, Number(limit) || 50));
  return AutonomousAction.find({})
    .sort({ createdAt: -1, _id: -1 })
    .limit(safeLimit)
    .select("agentRole actionType confidenceScore actionTaken targetModel targetId status createdAt")
    .lean();
}

module.exports = {
  logAction,
  undoAction,
  getRecentActions,
};
