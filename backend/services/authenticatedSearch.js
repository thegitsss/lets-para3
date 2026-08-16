const { applyPublicParalegalFilter } = require("../utils/paralegalProfile");

const SEARCH_QUERY_MIN = 2;
const SEARCH_QUERY_MAX = 80;
const SEARCH_RESULT_LIMIT = 6;
const SEARCH_CANDIDATE_LIMIT = 36;
const SUPPORTED_TYPES = new Set(["matter", "profile"]);

const escapeRegex = (value = "") => String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const normalizeId = (value) => String(value?._id || value?.id || value || "");
const sameId = (left, right) => Boolean(normalizeId(left)) && normalizeId(left) === normalizeId(right);
const normalizeRankText = (value = "") => normalizeSearchQuery(value).toLocaleLowerCase("en-US");

function normalizeSearchQuery(value) {
  return String(value || "")
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function parseSearchTypes(value) {
  const raw = Array.isArray(value) ? value : String(value || "matter,profile").split(",");
  const types = [...new Set(raw.map((item) => String(item || "").trim().toLowerCase()).filter(Boolean))];
  if (!types.length || types.some((type) => !SUPPORTED_TYPES.has(type))) return null;
  return types;
}

function humanizeStatus(value) {
  const normalized = String(value || "open").trim().toLowerCase().replace(/_/g, " ");
  const labels = {
    open: "Posted",
    "in progress": "In progress",
    paused: "Paused",
    completed: "Completed",
    disputed: "Disputed",
    closed: "Closed",
  };
  return labels[normalized] || normalized.replace(/\b\w/g, (char) => char.toUpperCase());
}

function matterRelationship(caseDoc, viewer) {
  const viewerId = normalizeId(viewer?.id || viewer?._id);
  const role = String(viewer?.role || "").toLowerCase();
  if (role === "attorney") return { code: "owner", label: "Your matter" };
  if (role === "admin") return { code: "administrator", label: "Administrator" };
  if (sameId(caseDoc?.paralegal, viewerId) || sameId(caseDoc?.paralegalId, viewerId)) {
    return { code: "assigned", label: "Assigned to you" };
  }
  if ((caseDoc?.applicants || []).some((applicant) =>
    sameId(applicant?.paralegalId, viewerId) && ["pending", "accepted"].includes(String(applicant?.status || "pending").toLowerCase())
  )) {
    return { code: "applicant", label: "You applied" };
  }
  return { code: "discoverable", label: "Open to apply" };
}

function matterAttention(caseDoc, viewer) {
  const status = String(caseDoc?.status || "").toLowerCase().replace(/_/g, " ");
  if (status === "disputed") return { code: "disputed", label: "Dispute needs review" };
  if (status === "paused") {
    return {
      code: "paused",
      label: String(viewer?.role || "").toLowerCase() === "attorney" ? "Review paused matter" : "Matter is paused",
    };
  }
  return null;
}

function presentMatter(caseDoc, viewer) {
  const id = normalizeId(caseDoc);
  const relationship = matterRelationship(caseDoc, viewer);
  const isParalegalDiscovery =
    String(viewer?.role || "").toLowerCase() === "paralegal" &&
    relationship.code !== "assigned";
  const href = isParalegalDiscovery
    ? `/browse-jobs.html?caseId=${encodeURIComponent(id)}`
    : `/case-detail.html?caseId=${encodeURIComponent(id)}`;
  return {
    type: "matter",
    id,
    title: String(caseDoc?.title || "Matter"),
    status: { code: String(caseDoc?.status || "open").toLowerCase().replace(/\s+/g, "_"), label: humanizeStatus(caseDoc?.status) },
    practiceArea: String(caseDoc?.practiceArea || ""),
    relationship,
    attention: matterAttention(caseDoc, viewer),
    nextAction: {
      label: isParalegalDiscovery ? "View opportunity" : "Open matter",
      href,
    },
  };
}

function presentMatterContext(caseDoc, viewer) {
  const base = presentMatter(caseDoc, viewer);
  const id = base.id;
  const role = String(viewer?.role || "").toLowerCase();
  const status = String(caseDoc?.status || "").toLowerCase().replace(/_/g, " ");
  let nextAction = base.nextAction;
  if (role === "attorney" && status === "open") {
    nextAction = {
      label: "Review applications",
      href: `/dashboard-attorney.html?openApplicants=1&caseId=${encodeURIComponent(id)}#cases:inquiries`,
    };
  } else if (role === "attorney" && ["completed", "closed"].includes(status)) {
    nextAction = {
      label: "View completed Matters",
      href: `/dashboard-attorney.html?highlightCase=${encodeURIComponent(id)}#cases:archived`,
    };
  } else if (base.relationship.code === "assigned" || ["in progress", "paused", "disputed"].includes(status)) {
    nextAction = { label: "Continue in this Matter", href: "#case-messages" };
  }
  return { ...base, nextAction };
}

function presentProfile(userDoc) {
  const id = normalizeId(userDoc);
  const name = [userDoc?.firstName, userDoc?.lastName].map((part) => String(part || "").trim()).filter(Boolean).join(" ");
  const focus = [
    ...(Array.isArray(userDoc?.specialties) ? userDoc.specialties : []),
    ...(Array.isArray(userDoc?.practiceAreas) ? userDoc.practiceAreas : []),
  ].map((item) => String(item || "").trim()).filter(Boolean);
  return {
    type: "profile",
    id,
    title: name || "Paralegal",
    headline: focus[0] || "Paralegal professional",
    location: String(userDoc?.location || userDoc?.state || ""),
    practiceAreas: [...new Set(focus)].slice(0, 3),
    nextAction: { label: "View profile", href: `/profile-paralegal.html?paralegalId=${encodeURIComponent(id)}` },
  };
}

function buildMatterAccessFilter(viewer, blockedIds = []) {
  const viewerId = normalizeId(viewer?.id || viewer?._id);
  const role = String(viewer?.role || "").toLowerCase();
  if (role === "attorney") {
    return { $or: [{ attorney: viewerId }, { attorneyId: viewerId }] };
  }
  if (role !== "paralegal") return null;

  const assigned = [
    { paralegal: viewerId, paralegalAccessRevokedAt: null },
    { paralegalId: viewerId, paralegalAccessRevokedAt: null },
  ];
  const related = [...assigned, {
    $and: [
      { paralegalAccessRevokedAt: null },
      { applicants: { $elemMatch: { paralegalId: viewerId, status: { $in: ["pending", "accepted"] } } } },
    ],
  }];
  const discoverable = {
    $and: [
      {
        $or: [
          {
            status: "open",
            archived: { $ne: true },
            paralegal: null,
            paralegalId: null,
          },
          {
            status: "paused",
            relistRequestedAt: { $ne: null },
            archived: { $ne: true },
            paralegal: null,
            paralegalId: null,
          },
        ],
      },
    ],
  };
  return {
    $and: [
      { status: { $nin: ["completed", "closed"] }, paymentReleased: { $ne: true } },
      { withdrawnParalegalId: { $ne: viewerId } },
      ...(blockedIds.length
        ? [{ attorney: { $nin: blockedIds } }, { attorneyId: { $nin: blockedIds } }]
        : []),
      {
        $nor: [
          {
            $and: [
              { paralegalAccessRevokedAt: { $ne: null } },
              { $or: [{ paralegal: viewerId }, { paralegalId: viewerId }] },
            ],
          },
        ],
      },
      { $or: [...related, discoverable] },
    ],
  };
}

function buildMatterSearchFilter(query, viewer, blockedIds = []) {
  const access = buildMatterAccessFilter(viewer, blockedIds);
  if (!access) return null;
  const tokens = normalizeSearchQuery(query).split(" ").filter(Boolean).slice(0, 8);
  return {
    $and: [
      access,
      ...tokens.map((token) => {
        const matcher = new RegExp(escapeRegex(token), "i");
        return { $or: [{ title: matcher }, { practiceArea: matcher }] };
      }),
    ],
  };
}

function buildProfileSearchFilter(query, blockedIds = []) {
  const matchers = String(query || "")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 8)
    .map((token) => new RegExp(escapeRegex(token), "i"));
  const filter = {
    role: "paralegal",
    status: "approved",
    disabled: { $ne: true },
    deleted: { $ne: true },
    "preferences.hideProfile": { $ne: true },
    $and: matchers.map((matcher) => ({
      $or: [
        { firstName: matcher },
        { lastName: matcher },
        { specialties: matcher },
        { practiceAreas: matcher },
        { location: matcher },
        { state: matcher },
      ],
    })),
  };
  if (blockedIds.length) filter._id = { $nin: blockedIds };
  applyPublicParalegalFilter(filter);
  return filter;
}

function rankSearchDocuments(docs = [], query, getPrimary, getFields, getUpdatedAt) {
  const normalizedQuery = normalizeRankText(query);
  const tokens = normalizedQuery.split(" ").filter(Boolean);
  return docs
    .map((doc) => {
      const primary = normalizeRankText(getPrimary(doc));
      const searchable = normalizeRankText(getFields(doc).filter(Boolean).join(" "));
      let tier = 1;
      if (primary === normalizedQuery) tier = 4;
      else if (primary.startsWith(normalizedQuery)) tier = 3;
      else if (tokens.length && tokens.every((token) => searchable.includes(token))) tier = 2;
      return {
        doc,
        tier,
        updatedAt: new Date(getUpdatedAt(doc) || 0).getTime() || 0,
        id: normalizeId(doc),
      };
    })
    .sort((left, right) => right.tier - left.tier || right.updatedAt - left.updatedAt || right.id.localeCompare(left.id))
    .slice(0, SEARCH_RESULT_LIMIT)
    .map((entry) => entry.doc);
}

async function searchAuthorizedObjects({ query, types, viewer, blockedIds = [], Case, User }) {
  const tasks = [];
  if (types.includes("matter")) {
    const filter = buildMatterSearchFilter(query, viewer, blockedIds);
    tasks.push(
      filter
        ? Case.find(filter)
            .sort({ updatedAt: -1, _id: -1 })
            .limit(SEARCH_CANDIDATE_LIMIT)
            .select({
              _id: 1,
              title: 1,
              status: 1,
              practiceArea: 1,
              attorney: 1,
              attorneyId: 1,
              paralegal: 1,
              paralegalId: 1,
              paralegalAccessRevokedAt: 1,
              applicants: { $elemMatch: { paralegalId: normalizeId(viewer?.id || viewer?._id), status: { $in: ["pending", "accepted"] } } },
              pausedReason: 1,
              relistRequestedAt: 1,
              paymentReleased: 1,
              updatedAt: 1,
            })
            .lean()
            .then((docs) => rankSearchDocuments(
              docs,
              query,
              (doc) => doc.title,
              (doc) => [doc.title, doc.practiceArea],
              (doc) => doc.updatedAt
            ))
            .then((docs) => ["matters", docs.map((doc) => presentMatter(doc, viewer))])
        : Promise.resolve(["matters", []])
    );
  }
  if (types.includes("profile") && String(viewer?.role || "").toLowerCase() === "attorney") {
    tasks.push(
      User.find(buildProfileSearchFilter(query, blockedIds))
        .sort({ updatedAt: -1, _id: -1 })
        .limit(SEARCH_CANDIDATE_LIMIT)
        .select("_id firstName lastName specialties practiceAreas location state updatedAt")
        .lean()
        .then((docs) => rankSearchDocuments(
          docs,
          query,
          (doc) => [doc.firstName, doc.lastName].filter(Boolean).join(" "),
          (doc) => [doc.firstName, doc.lastName, ...(doc.specialties || []), ...(doc.practiceAreas || []), doc.location, doc.state],
          (doc) => doc.updatedAt
        ))
        .then((docs) => ["profiles", docs.map(presentProfile)])
    );
  }
  const groups = Object.fromEntries(await Promise.all(tasks));
  return { matters: groups.matters || [], profiles: groups.profiles || [] };
}

module.exports = {
  SEARCH_QUERY_MIN,
  SEARCH_QUERY_MAX,
  SEARCH_RESULT_LIMIT,
  SEARCH_CANDIDATE_LIMIT,
  buildMatterAccessFilter,
  buildMatterSearchFilter,
  buildProfileSearchFilter,
  humanizeStatus,
  matterRelationship,
  normalizeSearchQuery,
  parseSearchTypes,
  presentMatter,
  presentMatterContext,
  presentProfile,
  rankSearchDocuments,
  searchAuthorizedObjects,
};
