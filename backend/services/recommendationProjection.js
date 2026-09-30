const STATE_CODES = new Map([
  ["ALABAMA", "AL"], ["ALASKA", "AK"], ["ARIZONA", "AZ"], ["ARKANSAS", "AR"],
  ["CALIFORNIA", "CA"], ["COLORADO", "CO"], ["CONNECTICUT", "CT"], ["DELAWARE", "DE"],
  ["DISTRICT OF COLUMBIA", "DC"], ["FLORIDA", "FL"], ["GEORGIA", "GA"], ["HAWAII", "HI"],
  ["IDAHO", "ID"], ["ILLINOIS", "IL"], ["INDIANA", "IN"], ["IOWA", "IA"],
  ["KANSAS", "KS"], ["KENTUCKY", "KY"], ["LOUISIANA", "LA"], ["MAINE", "ME"],
  ["MARYLAND", "MD"], ["MASSACHUSETTS", "MA"], ["MICHIGAN", "MI"], ["MINNESOTA", "MN"],
  ["MISSISSIPPI", "MS"], ["MISSOURI", "MO"], ["MONTANA", "MT"], ["NEBRASKA", "NE"],
  ["NEVADA", "NV"], ["NEW HAMPSHIRE", "NH"], ["NEW JERSEY", "NJ"], ["NEW MEXICO", "NM"],
  ["NEW YORK", "NY"], ["NORTH CAROLINA", "NC"], ["NORTH DAKOTA", "ND"], ["OHIO", "OH"],
  ["OKLAHOMA", "OK"], ["OREGON", "OR"], ["PENNSYLVANIA", "PA"], ["RHODE ISLAND", "RI"],
  ["SOUTH CAROLINA", "SC"], ["SOUTH DAKOTA", "SD"], ["TENNESSEE", "TN"], ["TEXAS", "TX"],
  ["UTAH", "UT"], ["VERMONT", "VT"], ["VIRGINIA", "VA"], ["WASHINGTON", "WA"],
  ["WEST VIRGINIA", "WV"], ["WISCONSIN", "WI"], ["WYOMING", "WY"],
]);
const GENERIC_PRACTICE_WORDS = new Set([
  "and", "the", "law", "legal", "practice", "matters", "matter", "litigation", "services", "support",
]);

function normalizeStateCode(value = "") {
  const normalized = String(value || "").trim().toUpperCase().replace(/\./g, "").replace(/\s+/g, " ");
  if (!normalized) return "";
  if (/^[A-Z]{2}$/.test(normalized)) return normalized;
  if (STATE_CODES.has(normalized)) return STATE_CODES.get(normalized);
  return normalized.match(/(?:,|\s)\s*([A-Z]{2})$/)?.[1] || normalized;
}

function practiceKey(value = "") {
  return String(value || "").toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9]+/g, " ").trim().replace(/\s+/g, " ");
}

function practiceTokens(value = "") {
  return practiceKey(value)
    .split(/\s+/)
    .filter((token) => token && !GENERIC_PRACTICE_WORDS.has(token))
    .map((token) => token.length > 3 && token.endsWith("s") ? token.slice(0, -1) : token);
}

function getPracticeMatch(matterArea = "", profileAreas = []) {
  const matterRawKey = practiceKey(matterArea);
  const matterTokens = practiceTokens(matterArea);
  if (!matterRawKey) return { score: 0, area: "" };
  return (Array.isArray(profileAreas) ? profileAreas : []).reduce((best, area) => {
    const profileRawKey = practiceKey(area);
    const profileTokens = practiceTokens(area);
    if (!profileRawKey) return best;
    let score = 0;
    if (matterRawKey === profileRawKey) score = 8;
    else if (matterRawKey.includes(profileRawKey) || profileRawKey.includes(matterRawKey)) score = 7;
    else if (matterTokens.length && profileTokens.length) {
      const overlap = matterTokens.filter((token) => new Set(profileTokens).has(token)).length;
      if (overlap) score = 5 + Math.min(1, overlap / Math.max(matterTokens.length, profileTokens.length));
    }
    return score > best.score ? { score, area: String(area) } : best;
  }, { score: 0, area: "" });
}

function listingIdentityIds(listing = {}) {
  return [listing.caseId, listing.contextCaseId, listing.id, listing._id, listing.jobId]
    .map((value) => String(value?._id || value?.id || value || "").trim())
    .filter(Boolean);
}

function createRecommendationRanker(profile = {}, exclusions = {}) {
  const states = new Set([
    ...(Array.isArray(profile.stateExperience) ? profile.stateExperience : []),
    profile.state,
    profile.location,
  ].map(normalizeStateCode).filter(Boolean));
  const practiceAreas = Array.isArray(profile.practiceAreas) ? profile.practiceAreas : [];
  const yearsExperience = Math.max(0, Number(profile.yearsExperience) || 0);
  const excluded = new Set([
    ...(exclusions.matterIds || []), ...(exclusions.caseIds || []), ...(exclusions.jobIds || []),
  ].map(String));

  function rank(listing) {
    if (!listingIdentityIds(listing).length || listingIdentityIds(listing).some((id) => excluded.has(id))) return null;
    const minimumYears = Math.max(0, Number(listing.minimumYearsExperience) || 0);
    if (minimumYears > yearsExperience) return null;
    const matterState = normalizeStateCode(listing.state || listing.locationState || listing.location?.state || listing.jurisdiction);
    const stateMatch = Boolean(matterState && states.has(matterState));
    const practice = getPracticeMatch(listing.practiceArea, practiceAreas);
    if (!stateMatch && !practice.score) return null;
    const score = (stateMatch ? 5 : 0) + practice.score + (stateMatch && practice.score ? 2 : 0);
    const reason = stateMatch && practice.score ? "state_and_practice" : stateMatch ? "state" : "practice_area";
    return { score, item: {
      ...listing,
      recommendation: {
        reason,
        matchedState: stateMatch ? matterState : null,
        matchedPracticeArea: practice.area || null,
        minimumYearsExperience: minimumYears,
      },
    } };
  }
  return { hasMatchingProfile: states.size > 0 || practiceAreas.length > 0, rank };
}

function compareRankedRecommendations(left, right) {
  return right.score - left.score || new Date(right.item.createdAt || 0) - new Date(left.item.createdAt || 0) ||
    String(listingIdentityIds(left.item)[0] || "").localeCompare(String(listingIdentityIds(right.item)[0] || ""));
}

function projectRecommendedMatters({ listings = [], profile = {}, exclusions = {} } = {}) {
  const ranker = createRecommendationRanker(profile, exclusions);
  const items = (Array.isArray(listings) ? listings : []).map(ranker.rank).filter(Boolean);
  items.sort(compareRankedRecommendations);
  return {
    hasMatchingProfile: ranker.hasMatchingProfile,
    items: items.map(value => value.item),
  };
}

module.exports = { normalizeStateCode, getPracticeMatch, listingIdentityIds, projectRecommendedMatters, createRecommendationRanker, compareRankedRecommendations };
