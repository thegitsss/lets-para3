function normalizeList(entries = []) {
  if (!Array.isArray(entries)) return [];
  return entries
    .map((entry) => {
      if (!entry) return "";
      if (typeof entry === "string") return entry.trim();
      return String(entry.name || entry.language || "").trim();
    })
    .filter(Boolean);
}

function shapeParalegalSnapshot(person = {}) {
  if (!person || typeof person !== "object") return {};
  const availabilityDetails =
    person.availabilityDetails && typeof person.availabilityDetails === "object"
      ? person.availabilityDetails.status || ""
      : "";
  const hasPhoto = Boolean(person.profileImage || person.avatarURL);

  return {
    location: person.location || "",
    availability: person.availability || availabilityDetails || "",
    yearsExperience:
      typeof person.yearsExperience === "number" ? person.yearsExperience : null,
    languages: normalizeList(person.languages),
    specialties: normalizeList(person.specialties),
    bio: person.bio || "",
    profileImage: hasPhoto ? buildAuthenticatedProfilePhotoUrl(person) : "",
  };
}

// Read presentation only: retain saved application fields, keep the existing
// authenticated current-photo treatment, and never spread a hydrated document.
function presentApplicationProfileSnapshot(stored, person = {}) {
  const base = shapeParalegalSnapshot(person);
  const saved = stored && typeof stored === "object"
    ? typeof stored.toObject === "function" ? stored.toObject() : stored
    : {};
  return { ...base, ...saved, profileImage: base.profileImage || "" };
}

module.exports = {
  shapeParalegalSnapshot,
  presentApplicationProfileSnapshot,
};
const { buildAuthenticatedProfilePhotoUrl } = require("../services/profilePhotoDelivery");
