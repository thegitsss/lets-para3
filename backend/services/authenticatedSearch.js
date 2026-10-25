const { applyPublicParalegalFilter } = require("../utils/paralegalProfile");

const SEARCH_QUERY_MIN = 2;
const SEARCH_QUERY_MAX = 80;
const SEARCH_RESULT_LIMIT = 6;
const SEARCH_CANDIDATE_LIMIT = 36;
const SEARCH_QUERY_TIMEOUT_MS = 5000;
const SEARCH_RANK_BATCH_SIZE = 100;
const SUPPORTED_TYPES = new Set(["matter", "profile", "file"]);

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
  if (value !== undefined && typeof value !== "string" && !Array.isArray(value)) return null;
  if (Array.isArray(value) && value.some((item) => typeof item !== "string")) return null;
  const raw = Array.isArray(value) ? value : String(value || "matter,profile").split(",");
  const types = [...new Set(raw.map((item) => String(item || "").trim().toLowerCase()).filter(Boolean))];
  if (!types.length || types.some((type) => !SUPPORTED_TYPES.has(type))) return null;
  return types;
}

function validateSearchRead(query = {}, viewer = {}) {
  const invalid = { status: 400, code: "SEARCH_QUERY_INVALID", error: "Enter one search query and a valid account expectation." };
  if (Object.keys(query).some((key) => /^(?:q|expectedOwnerId|types)[\[.]/.test(key))) return { error: invalid };
  if (query.q !== undefined && typeof query.q !== "string") return { error: invalid };
  if (!Object.hasOwn(query, "expectedOwnerId")) return { ownerId: null };
  if (typeof query.expectedOwnerId !== "string" || !/^[a-f\d]{24}$/i.test(query.expectedOwnerId)) return { error: invalid };
  const ownerId = query.expectedOwnerId.toLowerCase();
  if (ownerId !== normalizeId(viewer.id || viewer._id).toLowerCase()) {
    return { error: { status: 403, code: "ACCOUNT_CHANGED", error: "Your account changed. Refresh before searching." } };
  }
  return { ownerId };
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

function buildMatterSearchFilter(query, viewer, blockedIds = [], postingCaseIds = []) {
  const access = buildMatterAccessFilter(viewer, blockedIds);
  if (!access) return null;
  if (/^[a-f0-9]{24}$/i.test(query)) return {$and:[access,{_id:query}]};
  const tokens = normalizeSearchQuery(query).split(" ").filter(Boolean);
  return {
    $and: [
      access,
      ...(postingCaseIds.length ? [{ $or: [
        { _id: { $in: postingCaseIds } },
        { $and: tokens.map((token) => {
          const matcher = new RegExp(escapeRegex(token), "i");
          return { $or: [{ title: matcher }, { practiceArea: matcher }] };
        }) },
      ] }] : tokens.map((token) => {
        const matcher = new RegExp(escapeRegex(token), "i");
        return { $or: [{ title: matcher }, { practiceArea: matcher }] };
      })),
    ],
  };
}

function buildProfileSearchFilter(query, blockedIds = []) {
  const matchers = String(query || "")
    .split(/\s+/)
    .filter(Boolean)
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

const stringValue = (value) => ({ $convert: { input: value, to: "string", onNull: "", onError: "" } });
const joinValues = (input) => ({ $reduce: { input, initialValue: "", in: { $concat: ["$$value", " ", stringValue("$$this")] } } });
const profileRankFields = { _id: 1, firstName: 1, lastName: 1, specialties: 1, practiceAreas: 1, location: 1, state: 1, updatedAt: 1 };
const matterRankFields = { _id: 1, title: 1, practiceArea: 1, updatedAt: 1 };

function searchRankPipeline({ filter, fields, primary, searchable, query }) {
  // Mongo lowercasing is used only for ASCII metadata. The cursor below handles
  // Unicode with the same JavaScript NFKC and locale rules as the original ranker.
  const common = [
    { $match: filter },
    { $project: { ...fields, __primary: primary, __searchable: searchable } },
    { $set: { __unicode: { $regexMatch: { input: "$__searchable", regex: "[^\\x00-\\x7f]" } } } },
  ];
  const normalized = { $toLower: { $reduce: {
    input: { $regexFindAll: { input: "$__primary", regex: "[^\\x00-\\x20\\x7f]+" } },
    initialValue: "",
    in: { $concat: ["$$value", { $cond: [{ $eq: ["$$value", ""] }, "", " "] }, "$$this.match"] },
  } } };
  const normalizedQuery = normalizeRankText(query);
  return {
    ordinary: [...common,
      { $match: { __unicode: false } },
      { $set: { __normalized: normalized } },
      { $set: {
        __rank: { $switch: { branches: [
          { case: { $eq: ["$__normalized", { $literal: normalizedQuery }] }, then: 4 },
          { case: { $eq: [{ $indexOfCP: ["$__normalized", { $literal: normalizedQuery }] }, 0] }, then: 3 },
        ], default: 2 } },
        __date: { $convert: { input: "$updatedAt", to: "date", onNull: new Date(0), onError: new Date(0) } },
      } },
      { $sort: { __rank: -1, __date: -1, _id: -1 } },
      { $limit: SEARCH_RESULT_LIMIT },
      { $project: fields },
    ],
    unicode: [...common, { $match: { __unicode: true } }, { $project: fields }],
  };
}

async function selectRankedDocuments({ Model, filter, fields, primary, searchable, query, getPrimary, getFields, projection }) {
  // Aggregations do not cast schema paths. Use the existing find casting so
  // ObjectId aliases and retained string values have exactly the prior policy.
  const castFilter = Model.find(filter).cast(Model);
  const pipeline = searchRankPipeline({ filter: castFilter, fields, primary, searchable, query });
  const deadline = Date.now() + SEARCH_QUERY_TIMEOUT_MS;
  const remaining = () => {
    const time = deadline - Date.now();
    if (time <= 0) throw Object.assign(new Error("Search query deadline exceeded"), { code: "SEARCH_TIMEOUT" });
    return time;
  };
  const rank = (docs) => rankSearchDocuments(docs, query, getPrimary, getFields, (doc) => doc.updatedAt);
  const boundedOptions = () => ({ maxTimeMS: remaining(), timeoutMS: remaining(), allowDiskUse: false });
  let selected = rank(await Model.aggregate(pipeline.ordinary).option(boundedOptions()));
  const cursor = Model.aggregate(pipeline.unicode).option({ ...boundedOptions(), timeoutMode: "cursorLifetime" }).cursor({ batchSize: SEARCH_RANK_BATCH_SIZE });
  try {
    for await (const doc of cursor) {
      remaining();
      selected = rank([...selected, doc]);
    }
  } finally { await cursor.close(); }
  remaining();
  if (!selected.length) return [];
  // Reauthorize selected rows and project only the current public DTO inputs.
  const rows = await Model.find({ $and: [filter, { _id: { $in: selected.map((doc) => doc._id) } }] })
    .select(projection).maxTimeMS(remaining()).setOptions({ timeoutMS: remaining() }).lean();
  const byId = new Map(rows.map((doc) => [normalizeId(doc), doc]));
  return selected.map((doc) => byId.get(normalizeId(doc))).filter(Boolean);
}

async function assignedPostingTitles({ query, viewer, blockedIds, Case, Job }) {
  if (!Job || String(viewer?.role || "").toLowerCase() !== "paralegal") return new Map();
  const viewerId = normalizeId(viewer?.id || viewer?._id);
  const access = buildMatterAccessFilter(viewer, blockedIds);
  const assigned = await Case.find({ $and: [access, { $or: [{ paralegal: viewerId }, { paralegalId: viewerId }] }] })
    .select("_id jobId attorneyId attorney").maxTimeMS(SEARCH_QUERY_TIMEOUT_MS).lean();
  if (!assigned.length) return new Map();
  const jobIds = assigned.map(doc => doc.jobId).filter(Boolean);
  if (!jobIds.length) return new Map();
  const tokens = normalizeSearchQuery(query).split(" ").filter(Boolean);
  const postings = await Job.find({ $and: [
    { _id: { $in: jobIds } },
    ...tokens.map(token => ({ title: new RegExp(escapeRegex(token), "i") })),
  ] }).select("_id caseId attorneyId title").maxTimeMS(SEARCH_QUERY_TIMEOUT_MS).lean();
  const byJobId = new Map(assigned.filter(doc => doc.jobId).map(doc => [normalizeId(doc.jobId), doc]));
  return new Map(postings.map(posting => {
    const matter = byJobId.get(normalizeId(posting._id));
    if (!matter || normalizeId(posting.caseId) !== normalizeId(matter._id)
      || normalizeId(posting.attorneyId) !== normalizeId(matter.attorneyId || matter.attorney)) return null;
    return [normalizeId(matter._id), posting.title];
  }).filter(Boolean));
}

async function linkedPersonMatters({query,viewer,blockedIds,Case,User}) {
  if(!User||/^[a-f0-9]{24}$/i.test(query))return [];
  const access=buildMatterAccessFilter(viewer,blockedIds);if(!access)return [];
  const related=await Case.find(access).select('_id attorney attorneyId paralegal paralegalId').maxTimeMS(SEARCH_QUERY_TIMEOUT_MS).lean();
  const fields=String(viewer.role).toLowerCase()==='paralegal'?['attorney','attorneyId']:['paralegal','paralegalId'];
  const ids=[...new Set(related.flatMap(m=>fields.map(k=>normalizeId(m[k]))).filter(id=>/^[a-f0-9]{24}$/i.test(id)))];if(!ids.length)return [];
  const people=await User.find({$and:[{_id:{$in:ids}},...normalizeSearchQuery(query).split(' ').filter(Boolean).map(token=>({$or:[{firstName:new RegExp(escapeRegex(token),'i')},{lastName:new RegExp(escapeRegex(token),'i')}]}))]}).select('_id').maxTimeMS(SEARCH_QUERY_TIMEOUT_MS).lean();
  const matches=new Set(people.map(p=>String(p._id)));return related.filter(m=>fields.some(k=>matches.has(normalizeId(m[k])))).map(m=>String(m._id));
}

// Search decrypted names only after current workspace authorization. No file
// bytes, storage references, previous assignments, or applicant files are returned.
async function searchAuthorizedFiles({query,viewer,Case}) {
  const {caseParticipantIdentity}=require('../utils/caseParticipantIdentity');
  const {canUseWorkspace}=require('../utils/caseState');
  const {applyAssignmentVisibility}=require('../utils/matterAssignmentVisibility');
  const {decryptCaseFilePayload}=require('../utils/dataEncryption');
  const CaseFile=require('../models/CaseFile');
  const ownerId=normalizeId(viewer.id||viewer._id),role=String(viewer.role).toLowerCase();
  const participant=role==='attorney'?{$or:[{attorney:ownerId},{attorneyId:ownerId}]}:{$or:[{paralegal:ownerId},{paralegalId:ownerId}],paralegalAccessRevokedAt:null};
  const deadline=Date.now()+SEARCH_QUERY_TIMEOUT_MS;
  const fields='_id title attorney attorneyId paralegal paralegalId status escrowStatus escrowIntentId paymentReleased archived readOnly purgedAt paralegalAccessRevokedAt withdrawnParalegalId hiredAt';
  const allowed=doc=>{const acl=caseParticipantIdentity(doc,ownerId);return !acl.identityConflict&&(role==='attorney'?acl.isAttorney:acl.isParalegal&&!doc.paralegalAccessRevokedAt)&&canUseWorkspace(doc)&&!doc.archived&&!doc.readOnly&&!doc.purgedAt;};
  const matters=(await Case.find(participant).select(fields).maxTimeMS(SEARCH_QUERY_TIMEOUT_MS).lean()).filter(allowed);
  if(!matters.length)return [];
  const byId=new Map(matters.map(m=>[String(m._id),m]));
  const filter={$or:matters.map(m=>applyAssignmentVisibility({caseId:m._id},m,{role,userId:ownerId}))};
  const matches=[],tokens=normalizeRankText(query).split(' ').filter(Boolean);
  const cursor=CaseFile.find(filter).select('_id caseId originalName createdAt').maxTimeMS(Math.max(1,deadline-Date.now())).lean().cursor();
  try {for await(const raw of cursor){if(Date.now()>deadline)throw new Error('Document search timed out');const file=decryptCaseFilePayload(raw);const matter=byId.get(String(file.caseId));const text=normalizeRankText(`${file.originalName || ''} ${matter?.title || ''}`);if(file.originalName&&tokens.every(t=>text.includes(t)))matches.push({file,matter});}}finally{await cursor.close();}
  matches.sort((a,b)=>String(a.file.originalName).localeCompare(String(b.file.originalName))||String(a.file._id).localeCompare(String(b.file._id)));
  const candidates=matches.slice(0,SEARCH_RESULT_LIMIT);
  if(!candidates.length)return [];
  const latest=await Case.find({$and:[participant,{_id:{$in:candidates.map(x=>x.matter._id)}}]}).select(fields).maxTimeMS(Math.max(1,deadline-Date.now())).lean();
  const unchanged=new Set(latest.filter(m=>allowed(m)&&JSON.stringify(m)===JSON.stringify(byId.get(String(m._id)))).map(m=>String(m._id)));
  return candidates.filter(x=>unchanged.has(String(x.matter._id))).map(({file,matter})=>({type:'file',id:String(file._id),title:String(file.originalName).slice(0,2000),matterId:String(matter._id),matterTitle:String(matter.title||'Matter'),nextAction:{label:'Open document',href:role==='attorney'?`/attorney-v2.html#/matters/${matter._id}/files?fileId=${file._id}`:`/paralegal-v2.html#/matter/${matter._id}?tab=files&fileId=${file._id}`}}));
}

async function searchAuthorizedObjects({ query, types, viewer, blockedIds = [], Case, Job, User }) {
  const tasks = [];
  if (types.includes("matter")) {
    const [postingTitles,personMatters] = await Promise.all([assignedPostingTitles({ query, viewer, blockedIds, Case, Job }),linkedPersonMatters({query,viewer,blockedIds,Case,User})]);
    const filter = buildMatterSearchFilter(query, viewer, blockedIds, [...new Set([...postingTitles.keys(),...personMatters])]);
    tasks.push(filter ? selectRankedDocuments({
      Model: Case, filter, fields: matterRankFields, query,
      primary: stringValue("$title"), searchable: joinValues(["$title", "$practiceArea"]),
      getPrimary: (doc) => doc.title, getFields: (doc) => [doc.title, doc.practiceArea],
      projection: {
        _id: 1, title: 1, status: 1, practiceArea: 1, attorney: 1, attorneyId: 1,
        paralegal: 1, paralegalId: 1, paralegalAccessRevokedAt: 1,
        applicants: { $elemMatch: { paralegalId: normalizeId(viewer?.id || viewer?._id), status: { $in: ["pending", "accepted"] } } },
        pausedReason: 1, relistRequestedAt: 1, paymentReleased: 1, updatedAt: 1,
      },
    }).then((docs) => ["matters", docs.map((doc) => presentMatter(postingTitles.has(normalizeId(doc)) ? { ...doc, title: postingTitles.get(normalizeId(doc)) } : doc, viewer))]) : Promise.resolve(["matters", []]));
  }
  if (types.includes("profile") && String(viewer?.role || "").toLowerCase() === "attorney") {
    tasks.push(selectRankedDocuments({
      Model: User, filter: buildProfileSearchFilter(query, blockedIds), fields: profileRankFields, projection: profileRankFields, query,
      primary: { $concat: [stringValue("$firstName"), " ", stringValue("$lastName")] },
      searchable: joinValues({ $concatArrays: [
        ["$firstName", "$lastName", "$location", "$state"],
        { $cond: [{ $isArray: "$specialties" }, "$specialties", []] },
        { $cond: [{ $isArray: "$practiceAreas" }, "$practiceAreas", []] },
      ] }),
      getPrimary: (doc) => [doc.firstName, doc.lastName].filter(Boolean).join(" "),
      getFields: (doc) => [doc.firstName, doc.lastName, ...(doc.specialties || []), ...(doc.practiceAreas || []), doc.location, doc.state],
    }).then((docs) => ["profiles", docs.map(presentProfile)]));
  }
  if(types.includes("file"))tasks.push(searchAuthorizedFiles({query,viewer,Case}).then(files=>["files",files]));
  const groups = Object.fromEntries(await Promise.all(tasks));
  return { matters: groups.matters || [], profiles: groups.profiles || [], ...(types.includes("file")?{files:groups.files||[]}: {}) };
}

module.exports = {
  SEARCH_QUERY_MIN,
  SEARCH_QUERY_MAX,
  SEARCH_RESULT_LIMIT,
  SEARCH_CANDIDATE_LIMIT,
  SEARCH_QUERY_TIMEOUT_MS,
  SEARCH_RANK_BATCH_SIZE,
  buildMatterAccessFilter,
  buildMatterSearchFilter,
  buildProfileSearchFilter,
  humanizeStatus,
  matterRelationship,
  normalizeSearchQuery,
  parseSearchTypes,
  validateSearchRead,
  presentMatter,
  presentMatterContext,
  presentProfile,
  rankSearchDocuments,
  searchAuthorizedObjects,
};
