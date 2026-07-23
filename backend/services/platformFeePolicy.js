function percentageFromEnvironment(primaryKey, fallbackKey, defaultValue) {
  const raw = process.env[primaryKey] ?? (fallbackKey ? process.env[fallbackKey] : undefined);
  const parsed = Number(raw ?? defaultValue);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100) return defaultValue;
  return parsed;
}

const DEFAULT_ATTORNEY_PLATFORM_FEE_PERCENT = percentageFromEnvironment(
  "PLATFORM_FEE_ATTORNEY_PERCENT",
  "PLATFORM_FEE_PERCENT",
  22
);
const DEFAULT_PARALEGAL_PLATFORM_FEE_PERCENT = percentageFromEnvironment(
  "PLATFORM_FEE_PARALEGAL_PERCENT",
  "",
  18
);

function getCurrentPlatformFeePolicy() {
  return {
    attorneyPercent: DEFAULT_ATTORNEY_PLATFORM_FEE_PERCENT,
    paralegalPercent: DEFAULT_PARALEGAL_PLATFORM_FEE_PERCENT,
    attorneyChargeTiming: "charged_when_hire_is_confirmed",
    historicalSource: "case_fee_snapshot",
  };
}

module.exports = {
  DEFAULT_ATTORNEY_PLATFORM_FEE_PERCENT,
  DEFAULT_PARALEGAL_PLATFORM_FEE_PERCENT,
  getCurrentPlatformFeePolicy,
};
