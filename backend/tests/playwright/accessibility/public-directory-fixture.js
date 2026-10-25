const PROFILE_ID = "64d2f9a72f3b4c5d6e7f8091";
const PROFILE_VERSION = "2026-08-28T12:00:00.000Z";

function directoryProfile(overrides = {}) {
  const id = overrides.id || PROFILE_ID;
  const title = overrides.title || "Alexandria Montgomery-Worthington the Third";
  const canonicalUrl = `/profile-paralegal.html?paralegalId=${id}`;
  return {
    _id: id,
    yearsExperience: overrides.yearsExperience ?? 12,
    avatarURL: overrides.avatarURL ?? "/phase-three-missing-portrait.jpg",
    presentation: {
      schemaVersion: 1,
      source: "server_projection",
      kind: "card",
      objectType: "profile",
      object: { id, title, canonicalUrl, version: PROFILE_VERSION },
      status: { code: "active", label: "Available", tone: "success" },
      attention: null,
      relationship: { code: "public", label: "Public profile" },
      readOnly: true,
      actions: [],
      details: [
        { label: "Location", value: "Washington, District of Columbia" },
        { label: "Practice areas", value: "Administrative Law, Intellectual Property" },
      ],
      summary: "Supports complex multi-jurisdiction litigation, discovery, and detailed filing calendars for growing legal teams.",
      freshness: {
        state: "current",
        sourceUpdatedAt: PROFILE_VERSION,
        projectedAt: PROFILE_VERSION,
      },
      links: { self: canonicalUrl },
    },
  };
}

module.exports = { directoryProfile };
