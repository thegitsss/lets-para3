function normalizeMinimumYears(value) {
  if (value === null || value === undefined || value === "") return 0;
  const years = Number(value);
  if (!Number.isFinite(years) || years <= 0) return 0;
  return Math.min(80, years);
}

function parseMinimumYears(value) {
  const match = String(value || "").match(/\d+(?:\.\d+)?/);
  return match ? normalizeMinimumYears(match[0]) : 0;
}

function resolveExperienceRequirement(source = {}, fallback = {}) {
  const preference = String(
    source?.experiencePreference ?? fallback?.experiencePreference ?? ""
  ).trim();
  const explicit = normalizeMinimumYears(
    source?.minimumYearsExperience ??
      source?.minimumExperienceYears ??
      fallback?.minimumYearsExperience ??
      fallback?.minimumExperienceYears
  );
  if (explicit > 0) return { preference, minimumYears: explicit };

  const preferenceYears = parseMinimumYears(preference);
  if (preferenceYears > 0) return { preference, minimumYears: preferenceYears };

  const legacyYears = parseMinimumYears(
    String(source?.briefSummary || fallback?.briefSummary || "").match(/Experience:\s*([^•\n]+)/i)?.[1]
  );
  return { preference, minimumYears: legacyYears };
}

module.exports = {
  normalizeMinimumYears,
  parseMinimumYears,
  resolveExperienceRequirement,
};
