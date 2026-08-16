const PUBLISHED_ATTORNEY_PLATFORM_FEE_PERCENT = 22;
const PUBLISHED_PARALEGAL_PLATFORM_FEE_PERCENT = 18;

function percentageFromEnvironment(env, key, defaultValue) {
  const raw = env[key];
  if (raw === undefined || String(raw).trim() === "") return defaultValue;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100) {
    throw new Error(`[config] ${key} must be a percentage from 0 to 100.`);
  }
  return parsed;
}

function resolvePlatformFeePolicy(env = process.env) {
  return {
    attorneyPercent: percentageFromEnvironment(
      env,
      "PLATFORM_FEE_ATTORNEY_PERCENT",
      PUBLISHED_ATTORNEY_PLATFORM_FEE_PERCENT
    ),
    paralegalPercent: percentageFromEnvironment(
      env,
      "PLATFORM_FEE_PARALEGAL_PERCENT",
      PUBLISHED_PARALEGAL_PLATFORM_FEE_PERCENT
    ),
    attorneyChargeTiming: "charged_when_hire_is_confirmed",
    paralegalChargeTiming: "deducted_from_completed_paid_work_before_payout",
    historicalSource: "case_fee_snapshot",
  };
}

const CURRENT_POLICY = resolvePlatformFeePolicy(process.env);
const DEFAULT_ATTORNEY_PLATFORM_FEE_PERCENT = CURRENT_POLICY.attorneyPercent;
const DEFAULT_PARALEGAL_PLATFORM_FEE_PERCENT = CURRENT_POLICY.paralegalPercent;

function parsePublishedPercentage(env, key, expected) {
  const parsed = percentageFromEnvironment(env, key, expected);
  if (parsed !== expected) {
    throw new Error(`[config] ${key} must match the published launch fee (${expected}%).`);
  }
  return parsed;
}

function assertPublishedPlatformFeePolicy(env = process.env) {
  if (String(env.PLATFORM_FEE_PERCENT || "").trim()) {
    throw new Error(
      "[config] PLATFORM_FEE_PERCENT is retired; use the explicit attorney and paralegal fee settings."
    );
  }
  return {
    attorneyPercent: parsePublishedPercentage(
      env,
      "PLATFORM_FEE_ATTORNEY_PERCENT",
      PUBLISHED_ATTORNEY_PLATFORM_FEE_PERCENT
    ),
    paralegalPercent: parsePublishedPercentage(
      env,
      "PLATFORM_FEE_PARALEGAL_PERCENT",
      PUBLISHED_PARALEGAL_PLATFORM_FEE_PERCENT
    ),
  };
}

function getCurrentPlatformFeePolicy() {
  return {
    attorneyPercent: DEFAULT_ATTORNEY_PLATFORM_FEE_PERCENT,
    paralegalPercent: DEFAULT_PARALEGAL_PLATFORM_FEE_PERCENT,
    attorneyChargeTiming: "charged_when_hire_is_confirmed",
    paralegalChargeTiming: "deducted_from_completed_paid_work_before_payout",
    historicalSource: "case_fee_snapshot",
  };
}

module.exports = {
  PUBLISHED_ATTORNEY_PLATFORM_FEE_PERCENT,
  PUBLISHED_PARALEGAL_PLATFORM_FEE_PERCENT,
  DEFAULT_ATTORNEY_PLATFORM_FEE_PERCENT,
  DEFAULT_PARALEGAL_PLATFORM_FEE_PERCENT,
  assertPublishedPlatformFeePolicy,
  getCurrentPlatformFeePolicy,
  resolvePlatformFeePolicy,
};
