"use strict";

// Read retained provider evidence only. A Matter's funding mode or today's
// Stripe configuration cannot establish the mode of an earlier transfer.
function inspect(matter, payout, operation) {
  const modes = [], providerModes = [];
  for (const [record, provider] of [[matter, false], [payout, true], [operation, true]]) {
    if (!record) continue;
    const value = record.stripeMode;
    if (value != null && value !== "" && value !== "unknown" && !["live", "test"].includes(value)) return null;
    if (["live", "test"].includes(value)) { modes.push(value); if (provider) providerModes.push(value); }
    if (provider && record.livemode != null) {
      if (typeof record.livemode !== "boolean") return null;
      const mode = record.livemode ? "live" : "test";
      modes.push(mode); providerModes.push(mode);
    }
  }
  return providerModes.length && new Set(modes).size === 1 ? providerModes[0] : null;
}

module.exports = { inspect };
