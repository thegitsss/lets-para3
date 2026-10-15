const { evidenceObservedAt, evidenceFreshnessMs } = require("./supportEvidenceFreshness");

// Request-local ownership is an internal execution fact, never a model-visible
// tool field. JSON/BSON copies cannot manufacture this WeakMap association.
const owners = new WeakMap();

function bindAccountOverviewToActor(entry = {}, user = {}) {
  if (entry.name !== "get_my_case_overview" || !entry.result || typeof entry.result !== "object") return entry;
  const id = String(user._id || user.id || "");
  const existing = owners.get(entry.result);
  if (!existing && String(user.role || "") === "attorney" && /^[a-f0-9]{24}$/i.test(id)) owners.set(entry.result, { id, role: "attorney" });
  return entry;
}

function aggregateCountClaims(sentence = "") {
  // This is a bounded grammar for entire count sentences, not a substring
  // exemption for prose that can also contain an individual-Matter claim.
  const text = String(sentence).trim().replace(/[.!]$/, "").replace(/[’‘]/g, "'")
    .replace(/^you've\b/i, "you have").replace(/\s+/g, " ")
    .replace(/(?: in your account)?(?: yet| so far)?$/i, "");
  const quantity = "(?:\\d+|no|zero|one|two|three|four|five|six|seven|eight|nine|ten)";
  const words = { no: 0, zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
  const countOf = value => words[value.toLowerCase()] ?? Number(value);
  let match = text.match(new RegExp(`^you (?:(?:currently )?have (?:currently )?)?completed (${quantity}) (?:cases?|matters?)$`, "i"));
  if (match) return [{ measure: "completed", count: countOf(match[1]) }];
  if (/^you (?:have not|haven't) completed (?:any )?(?:cases?|matters?)$/i.test(text)) return [{ measure: "completed", count: 0 }];
  match = text.match(/^(?:you (?:currently )?have|there (?:are|is)|your account has) (?:currently )?(.+)$/i);
  if (!match) return [];
  const parts = match[1].replace(/,\s*and\s+/gi, ",").split(/\s*,\s*|\s+and\s+/i);
  if (!parts.length || parts.length > 3 || !/\b(?:cases?|matters?)\b/i.test(match[1])) return [];
  const claims = [];
  for (const part of parts) {
    const measured = part.match(new RegExp(`^(${quantity}) (active|completed|total)(?: (?:cases?|matters?))?$`, "i"));
    const total = part.match(new RegExp(`^(?:a total of )?(${quantity}) (?:cases?|matters?)(?: in total| overall)?$`, "i"));
    if (measured) claims.push({ measure: measured[2].toLowerCase(), count: countOf(measured[1]) });
    else if (total) claims.push({ measure: "total", count: countOf(total[1]) });
    else return [];
  }
  return new Set(claims.map(c => c.measure)).size === claims.length ? claims : [];
}

function supportedAccountOverviewSentence(sentence, toolOutputs = [], { accountOwnerId = "", now = Date.now() } = {}) {
  const claims = aggregateCountClaims(sentence);
  if (!claims.length || !/^[a-f0-9]{24}$/i.test(String(accountOwnerId))) return false;
  return toolOutputs.some(entry => {
    if (entry?.name !== "get_my_case_overview") return false;
    const result = entry.result, binding = result && owners.get(result), evidence = result?.evidence || {};
    if (binding?.id !== String(accountOwnerId) || binding.role !== "attorney" || result.role !== "attorney") return false;
    if (result.ok !== true || result.available !== true || result.evidenceState !== "verified" || evidence.state !== "verified" || evidence.authorized !== true) return false;
    if (evidence.source !== entry.name || evidence.capabilityId !== "A01_matter_overview" || evidence.sourceType !== "authorized_tool_snapshot" || evidence.policyOrLiveState !== "live_state" || evidence.subjectType !== "attorney_account" || evidence.matterId) return false;
    if (evidence.subjectId && String(evidence.subjectId) !== String(accountOwnerId)) return false;
    const observedAt = evidenceObservedAt(entry), age = now - observedAt;
    if (!Number.isFinite(observedAt) || age < 0 || age > evidenceFreshnessMs(entry.name)) return false;
    const values = {};
    for (const measure of ["total", "active", "completed"]) {
      const key = measure + "Count", count = result[key];
      if (!Number.isSafeInteger(count) || count < 0) return false;
      const facts = (evidence.facts || []).filter(f => f.key === key);
      if (facts.length !== 1 || facts[0].value !== count || facts[0].claimType !== "fact" || facts[0].policyOrLiveState !== "live_state" || facts[0].subjectType !== "attorney_account" || facts[0].matterId || (facts[0].subjectId && String(facts[0].subjectId) !== String(accountOwnerId))) return false;
      values[measure] = count;
    }
    if (values.active + values.completed !== values.total) return false;
    return claims.every(c => Number.isSafeInteger(c.count) && c.count === values[c.measure]);
  });
}

module.exports = { bindAccountOverviewToActor, aggregateCountClaims, supportedAccountOverviewSentence };
