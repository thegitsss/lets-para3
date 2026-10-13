const mongoose = require("mongoose");
const { getAiStatus } = require("./config");
const { createLogger } = require("../utils/logger");

const logger = createLogger("ai:monitoring");

function getAgentIssueModel() {
  try {
    return require("../models/AgentIssue");
  } catch (_) {
    return null;
  }
}

function sumCounts(counts, keys) {
  return keys.reduce((sum, key) => sum + Number(counts[key] || 0), 0);
}

function buildAlert({ severity, code, message, count }) {
  return {
    severity,
    code,
    message,
    count,
  };
}

function addSuggestedAction(actions, value) {
  if (value && !actions.includes(value)) actions.push(value);
}

async function checkSystemHealth() {
  const dbReady = mongoose.connection.readyState === 1;
  const aiStatus = getAiStatus();

  return {
    ok: dbReady,
    generatedAt: new Date().toISOString(),
    checks: {
      database: {
        ok: dbReady,
        state: mongoose.connection.readyState,
      },
      ai: {
        enabled: aiStatus.enabled,
        hasApiKey: aiStatus.hasApiKey,
      },
    },
  };
}

async function analyzeRecentIssues({ hours = 6 } = {}) {
  const AgentIssue = getAgentIssueModel();
  const generatedAt = new Date();
  const windowStart = new Date(generatedAt.getTime() - Math.max(1, Number(hours) || 6) * 60 * 60 * 1000);
  const countsByCategory = {};
  const countsByUrgency = {};
  const alerts = [];
  const suggestedActions = [];

  if (!AgentIssue || mongoose.connection.readyState !== 1) {
    return {
      ok: false,
      generatedAt: generatedAt.toISOString(),
      hours: Math.max(1, Number(hours) || 6),
      windowStart: windowStart.toISOString(),
      countsByCategory,
      countsByUrgency,
      alerts: [
        buildAlert({
          severity: "high",
          code: "agent_issues_unavailable",
          message: "Agent issue analysis is unavailable because MongoDB is not connected.",
          count: 0,
        }),
      ],
      suggestedActions: [
        "Restore MongoDB connectivity before relying on agent issue trend analysis.",
      ],
    };
  }

  const recentIssues = await AgentIssue.find({ createdAt: { $gte: windowStart } })
    .select("category urgency createdAt status")
    .lean();

  recentIssues.forEach((issue) => {
    const category = String(issue.category || "unknown");
    const urgency = String(issue.urgency || "low");
    countsByCategory[category] = (countsByCategory[category] || 0) + 1;
    countsByUrgency[urgency] = (countsByUrgency[urgency] || 0) + 1;
  });

  const loginCount = sumCounts(countsByCategory, ["login", "password_reset"]);
  const profileSaveCount = sumCounts(countsByCategory, ["profile_save"]);
  const paymentCount = sumCounts(countsByCategory, ["payment", "stripe_onboarding"]);

  if (loginCount >= 3) {
    alerts.push(
      buildAlert({
        severity: "high",
        code: "repeated_login_failures",
        message: "Multiple login or password-reset issues were reported in the recent monitoring window.",
        count: loginCount,
      })
    );
    addSuggestedAction(suggestedActions, "Review auth logs, failed login counters, and password-reset email delivery.");
  }

  if (profileSaveCount >= 3) {
    alerts.push(
      buildAlert({
        severity: "medium",
        code: "repeated_profile_save_failures",
        message: "Multiple profile save complaints were reported recently.",
        count: profileSaveCount,
      })
    );
    addSuggestedAction(suggestedActions, "Review profile update validation and persistence behavior for recent deploy changes.");
  }

  if (paymentCount >= 3) {
    alerts.push(
      buildAlert({
        severity: "high",
        code: "repeated_payment_or_onboarding_failures",
        message: "Multiple payment or Stripe onboarding issues were reported recently.",
        count: paymentCount,
      })
    );
    addSuggestedAction(suggestedActions, "Review Stripe Connect status checks, payment intent failures, and billing flows.");
  }

  if ((countsByUrgency.high || 0) >= 3) {
    addSuggestedAction(suggestedActions, "Review the newest high-priority support issues first and confirm whether one outage is driving several reports.");
  }

  return {
    ok: alerts.every((alert) => alert.severity !== "high"),
    generatedAt: generatedAt.toISOString(),
    hours: Math.max(1, Number(hours) || 6),
    windowStart: windowStart.toISOString(),
    countsByCategory,
    countsByUrgency,
    alerts,
    suggestedActions,
  };
}

async function generateMonitoringReport(options = {}) {
  try {
    const [health, issueAnalysis] = await Promise.all([
      checkSystemHealth(),
      analyzeRecentIssues(options),
    ]);

    return {
      ok: Boolean(health.ok) && Boolean(issueAnalysis.ok),
      generatedAt: new Date().toISOString(),
      checks: health.checks,
      countsByCategory: issueAnalysis.countsByCategory,
      countsByUrgency: issueAnalysis.countsByUrgency,
      alerts: issueAnalysis.alerts,
      suggestedActions: issueAnalysis.suggestedActions,
      windowStart: issueAnalysis.windowStart,
      hours: issueAnalysis.hours,
    };
  } catch (err) {
    logger.error("Monitoring report generation failed.", err?.message || err);
    return {
      ok: false,
      generatedAt: new Date().toISOString(),
      countsByCategory: {},
      countsByUrgency: {},
      alerts: [
        buildAlert({
          severity: "high",
          code: "monitoring_failed",
          message: "Monitoring report generation failed.",
          count: 0,
        }),
      ],
      suggestedActions: ["Review backend logs for the monitoring agent failure."],
    };
  }
}

module.exports = {
  analyzeRecentIssues,
  checkSystemHealth,
  generateMonitoringReport,
};
