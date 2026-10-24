"use strict";

const PARALEGAL_TOUR_IDS = Object.freeze([
  "welcome-v1", "profile-v1", "browse-v1", "matters-v1", "workspace-v1",
]);
const STATUSES = new Set(["completed", "dismissed"]);

function serializePortalTours(value = {}) {
  const source = value instanceof Map ? Object.fromEntries(value) : value;
  return Object.fromEntries(PARALEGAL_TOUR_IDS.filter(id => STATUSES.has(source?.[id])).map(id => [id, source[id]]));
}

function portalTourUpdates(value, role) {
  if (role !== "paralegal" || !value || typeof value !== "object" || Array.isArray(value)) return null;
  const entries = Object.entries(value);
  if (!entries.length || entries.some(([id, status]) => !PARALEGAL_TOUR_IDS.includes(id) || !STATUSES.has(status))) return null;
  const updates = Object.fromEntries(entries.map(([id, status]) => [`onboarding.paralegalTours.${id}`, status]));
  if (Object.hasOwn(value, "welcome-v1")) {
    updates["onboarding.paralegalWelcomePending"] = false;
    updates["onboarding.paralegalTourCompleted"] = true;
  }
  return updates;
}

module.exports = { PARALEGAL_TOUR_IDS, serializePortalTours, portalTourUpdates };
