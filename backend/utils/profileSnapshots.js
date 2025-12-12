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

  return {
    location: person.location || "",
    availability: person.availability || availabilityDetails || "",
    yearsExperience:
      typeof person.yearsExperience === "number" ? person.yearsExperience : null,
    languages: normalizeList(person.languages),
    specialties: normalizeList(person.specialties),
    bio: person.bio || "",
    profileImage: person.profileImage || person.avatarURL || "",
  };
}

module.exports = {
  shapeParalegalSnapshot,
};
