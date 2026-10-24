const mongoose = require("mongoose");
const Case = require("../models/Case"), Job = require("../models/Job"), User = require("../models/User"), Application = require("../models/Application");
const { getBlockedUserIds } = require("../utils/blocks");
const { buildAuthenticatedProfilePhotoUrl } = require("./profilePhotoDelivery");
const { resolveExperienceRequirement } = require("./experienceRequirement");
const { resolveMatterDeadlineDate, normalizeDateOnly, dateOnlyFromZonedInstant, addCalendarDays } = require("../utils/businessDate");
const { buildApplicationEligibility, resolveLivePayoutReadiness } = require("./paralegalReadinessService");
const { normalizeStateCode, createRecommendationRanker, compareRankedRecommendations } = require("./recommendationProjection");
const { getHistoricalRecommendationExclusions } = require("./recommendationExclusionService");

function openDiscoveryCaseFilter() {
  return {
    archived: { $ne: true },
    $or: [
      { status: "open" },
      {
        status: "paused",
        payoutFinalizedAt: { $ne: null },
        $or: [
          { relistRequestedAt: { $ne: null } },
          { payoutFinalizedType: { $in: ["zero_auto", "partial_attorney", "expired_zero", "admin"] } },
        ],
      },
    ],
    paralegal: null,
    paralegalId: null,
  };
}

function buildAttorneyPreview(doc) {
  if (!doc || typeof doc !== "object") return null;
  const normalizedId = normalizeId(doc);
  return {
    _id: normalizedId,
    firstName: doc.firstName || "",
    lastName: doc.lastName || "",
    lawFirm: doc.lawFirm || doc.firmName || "",
    profileImage:
      doc.profileImage || doc.avatarURL
        ? buildAuthenticatedProfilePhotoUrl(doc)
        : "",
  };
}

function normalizeId(source) {
  if (!source) return null;
  if (typeof source === "string") return source;
  if (typeof source === "object") {
    if (source._id) return source._id;
    if (typeof source.toString === "function") return source.toString();
    return null;
  }
  return source;
}

function shapeListing({ job = null, caseDoc = null }) {
  const autoRelistTypes = new Set(["zero_auto", "partial_attorney", "expired_zero", "admin"]);
  const autoRelistFallback =
    !caseDoc?.relistRequestedAt &&
    caseDoc?.payoutFinalizedAt &&
    autoRelistTypes.has(String(caseDoc?.payoutFinalizedType || ""));
  const totalAmount = typeof caseDoc?.totalAmount === "number" ? caseDoc.totalAmount : null;
  const lockedTotalAmount = typeof caseDoc?.lockedTotalAmount === "number" ? caseDoc.lockedTotalAmount : null;
  const remainingAmount = typeof caseDoc?.remainingAmount === "number" ? caseDoc.remainingAmount : null;
  const amountForCase =
    remainingAmount != null ? remainingAmount : lockedTotalAmount != null ? lockedTotalAmount : totalAmount;
  const budgetFromCase = amountForCase != null ? Math.round(amountForCase / 100) : null;
  const attorneySource = caseDoc?.attorney || caseDoc?.attorneyId || job?.attorneyId || null;
  const normalizedAttorneyId =
    normalizeId(caseDoc?.attorney) || normalizeId(caseDoc?.attorneyId) || normalizeId(job?.attorneyId);
  const jobState = job?.state || job?.locationState || "";
  const caseState = caseDoc?.state || caseDoc?.locationState || "";
  const resolvedState = caseState || jobState;
  const experienceRequirement = resolveExperienceRequirement(caseDoc || {}, job || {});

  return {
    id: caseDoc?._id || job?.caseId || job?._id,
    _id: caseDoc?._id || job?._id,
    caseId: caseDoc?._id || job?.caseId || null,
    jobId: job?._id || caseDoc?.jobId || null,
    title: caseDoc?.title || job?.title || "Untitled Matter",
    practiceArea: caseDoc?.practiceArea || job?.practiceArea || "",
    briefSummary: caseDoc?.briefSummary || "",
    shortDescription: job?.shortDescription || caseDoc?.briefSummary || "",
    description: caseDoc?.details || job?.description || "",
    totalAmount,
    lockedTotalAmount,
    remainingAmount,
    budget: budgetFromCase != null ? budgetFromCase : typeof job?.budget === "number" ? job.budget : null,
    currency: caseDoc?.currency || "usd",
    state: resolvedState,
    locationState: caseDoc?.locationState || caseDoc?.state || job?.locationState || job?.state || "",
    experiencePreference: experienceRequirement.preference,
    minimumYearsExperience: experienceRequirement.minimumYears,
    requirements: caseDoc?.requirements || job?.requirements || [],
    createdAt: job?.createdAt || caseDoc?.createdAt || null,
    deadlineDate: resolveMatterDeadlineDate(caseDoc),
    deadline: resolveMatterDeadlineDate(caseDoc) || null,
    attorneyId: normalizedAttorneyId,
    attorney: buildAttorneyPreview(attorneySource),
    applicantsCount: job
      ? Math.max(0, Number(job.applicantsCount || 0))
      : Array.isArray(caseDoc?.applicants)
        ? caseDoc.applicants.filter(
            (entry) => String(entry?.status || "pending").toLowerCase() === "pending"
          ).length
        : 0,
    status: caseDoc?.status || job?.status || "open",
    contextCaseId: caseDoc?._id || job?.caseId || null,
    tasks: Array.isArray(caseDoc?.tasks) ? caseDoc.tasks : [],
    relistRequestedAt: caseDoc?.relistRequestedAt || (autoRelistFallback ? caseDoc.payoutFinalizedAt : null),
    payoutFinalizedAt: caseDoc?.payoutFinalizedAt || null,
  };
}

const CASE_FIELDS = "_id title practiceArea details briefSummary experiencePreference minimumYearsExperience totalAmount lockedTotalAmount remainingAmount currency state locationState status applicants attorney attorneyId jobId job createdAt deadline deadlineDate tasks requirements relistRequestedAt payoutFinalizedAt payoutFinalizedType".split(" ");
const asString = input => ({ $convert: { input, to: "string", onError: "", onNull: "" } });
const nonempty = (first, fallback) => ({ $cond: [{ $ne: [{ $ifNull: [first, ""] }, ""] }, first, fallback] });
const validDate = input => ({ $convert: { input, to: "date", onError: null, onNull: null } });

function catalogPipeline(viewerId, blockedIds, sort) {
  const blocked = blockedIds.flatMap(value => [new mongoose.Types.ObjectId(String(value)), String(value)]);
  const caseFilter = { ...openDiscoveryCaseFilter(), ...(blocked.length ? { attorney: { $nin: blocked }, attorneyId: { $nin: blocked } } : {}) };
  const jobFilter = { status: "open", ...(blocked.length ? { attorneyId: { $nin: blocked } } : {}) };
  const deadlineText = { $substrBytes: [asString(nonempty("$caseDoc.deadlineDate", "$caseDoc.deadline")), 0, 10] };
  const deadlineDate = { $dateFromString: { dateString: deadlineText, format: "%Y-%m-%d", onError: null, onNull: null } };
  const deadlineRoundTrip = { $dateToString: { date: deadlineDate, format: "%Y-%m-%d", onNull: "" } };
  const amount = ["totalAmount", "lockedTotalAmount", "remainingAmount"].reduce((fallback, field) => ({
    $cond: [{ $isNumber: `$caseDoc.${field}` }, { $divide: [`$caseDoc.${field}`, 100] }, fallback],
  }), { $ifNull: ["$job.budget", 0] });
  const order = sort === "payHigh" ? { _amount: -1, _created: -1, _identity: 1 }
    : sort === "payLow" ? { _amount: 1, _created: -1, _identity: 1 }
      : sort === "deadline" ? { _deadline: 1, _created: -1, _identity: 1 }
        : { _created: -1, _identity: 1 };
  return [
    { $match: caseFilter },
    { $set: { _caseRefs: ["$_id", asString("$_id")], _jobRefs: ["$jobId", "$job",
      { $convert: { input: "$jobId", to: "objectId", onError: null, onNull: null } },
      { $convert: { input: "$job", to: "objectId", onError: null, onNull: null } },
    ] } },
    { $lookup: { from: Job.collection.name, localField: "_caseRefs", foreignField: "caseId",
      let: { owner: asString("$attorney"), aliasOwner: asString("$attorneyId") },
      pipeline: [
        { $match: { ...jobFilter, $expr: { $in: [asString("$attorneyId"), ["$$owner", "$$aliasOwner"]] } } },
        { $sort: { createdAt: -1, _id: -1 } }, { $limit: 2 },
      ], as: "_directJobs",
    } },
    { $lookup: { from: Job.collection.name, localField: "_jobRefs", foreignField: "_id",
      let: { owner: asString("$attorney"), aliasOwner: asString("$attorneyId") },
      pipeline: [
        { $match: { ...jobFilter, $or: [{ caseId: null }, { caseId: "" }], $expr: { $in: [asString("$attorneyId"), ["$$owner", "$$aliasOwner"]] } } },
        { $set: { _postingRefs: ["$_id", asString("$_id")] } },
        ...["jobId", "job"].map(field => ({ $lookup: { from: Case.collection.name, localField: "_postingRefs", foreignField: field,
          pipeline: [{ $project: { _id: 1 } }, { $limit: 2 }], as: `_linked_${field}`,
        } })),
        // Ambiguous reverse links have no authoritative Job application target.
        // Keep each real Case discoverable through its own Case application API.
        { $match: { $expr: { $lte: [{ $size: { $setUnion: ["$_linked_jobId._id", "$_linked_job._id"] } }, 1] } } },
        { $sort: { createdAt: -1, _id: -1 } }, { $limit: 1 },
      ], as: "_reverseJobs",
    } },
    { $project: { _id: 0, directJobCount: { $size: "$_directJobs" }, caseDoc: Object.fromEntries(CASE_FIELDS.map(field => [field, `$${field}`])), job: { $ifNull: [{ $first: "$_directJobs" }, { $first: "$_reverseJobs" }, null] } } },
    { $unionWith: { coll: Job.collection.name, pipeline: [
      { $match: { ...jobFilter, $or: [{ caseId: null }, { caseId: "" }] } },
      // A reverse-linked Job belongs to its Case. Closed/assigned or otherwise
      // ineligible Cases must not leak back into discovery as orphan Jobs.
      { $set: { _postingRefs: ["$_id", asString("$_id")] } },
      ...["jobId", "job"].map(field => ({ $lookup: { from: Case.collection.name, localField: "_postingRefs", foreignField: field,
        pipeline: [{ $project: { _id: 1 } }, { $limit: 1 }], as: `_linked_${field}`,
      } })),
      { $match: { "_linked_jobId.0": { $exists: false }, "_linked_job.0": { $exists: false } } },
      { $project: { _id: 0, caseDoc: { $literal: null }, job: "$$ROOT" } },
    ] } },
    { $set: { _postingRefs: ["$job._id", asString("$job._id")] } },
    { $lookup: { from: Application.collection.name, localField: "_postingRefs", foreignField: "jobId", pipeline: [
      { $match: { paralegalId: { $in: [new mongoose.Types.ObjectId(String(viewerId)), String(viewerId)] }, status: { $ne: "withdrawn" },
        jobId: { $ne: null },
      } }, { $sort: { createdAt: -1, _id: -1 } }, { $project: { createdAt: 1 } }, { $limit: 1 },
    ], as: "_applications" } },
    { $set: {
      _amount: amount,
      _created: { $ifNull: [validDate(nonempty("$job.createdAt", "$caseDoc.createdAt")), new Date(0)] },
      _deadline: { $cond: [{ $and: [{ $ne: [deadlineText, ""] }, { $eq: [deadlineText, deadlineRoundTrip] }] }, deadlineText, "9999-12-31"] },
      _identity: asString({ $ifNull: ["$caseDoc._id", "$job._id"] }),
    } },
    { $sort: order },
  ];
}

async function* iterateOpenListings(viewerId, { sort = "newest" } = {}) {
  const blockedIds = await getBlockedUserIds(viewerId);
  const cursor = Case.aggregate(catalogPipeline(viewerId, blockedIds, sort))
    .allowDiskUse(true).option({ maxTimeMS: 15000 }).cursor({ batchSize: 100 });
  try {
    for await (const row of cursor) {
      const caseDoc = row.caseDoc && { ...row.caseDoc, jobId: row.job?._id || null };
      const listing = shapeListing({ caseDoc, job: row.job });
      const source = row.caseDoc, logicalId = value => String(value || "").toLowerCase();
      // Retained inconsistent links remain reviewable, but cannot advertise a
      // ready action which the canonical application review cannot reconcile.
      listing.applicationTargetVerified = !source || !(
        row.directJobCount > 1 ||
        source.attorney && source.attorneyId && logicalId(source.attorney) !== logicalId(source.attorneyId) ||
        source.job && source.jobId && logicalId(source.job) !== logicalId(source.jobId) ||
        (source.jobId || source.job) && logicalId(source.jobId || source.job) !== logicalId(row.job?._id) ||
        row.job && logicalId(row.job.caseId) !== logicalId(source._id)
      );
      const appliedAt = row._applications?.[0]?.createdAt;
      if (appliedAt) listing.appliedAt = appliedAt;
      yield listing;
    }
  } finally { await cursor.close(); }
}

function invalidQuery() { throw Object.assign(new Error("Invalid Matter discovery query."), { status: 400, publicCode: "DISCOVERY_INVALID_QUERY" }); }
function parseDiscoveryQuery(query = {}, { browse = false } = {}) {
  const text = (key, max = 200) => {
    if (query[key] === undefined) return "";
    if (typeof query[key] !== "string" || query[key].length > max) invalidQuery();
    return query[key].trim();
  };
  const integer = (key, fallback, max = Number.MAX_SAFE_INTEGER) => {
    const value = text(key, 20); if (!value) return fallback;
    if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) invalidQuery();
    return Math.min(Number(value), max);
  };
  const page = integer("page", 1), limit = integer("limit", browse ? 12 : 200, 500);
  if (!Number.isSafeInteger((page - 1) * limit)) invalidQuery();
  const sort = text("sort") || "newest", deadline = text("deadline"), posted = text("posted");
  if (!["newest", "deadline", "payHigh", "payLow"].includes(sort) || !["", "7_days", "30_days", "none"].includes(deadline) || !["", "7_days", "30_days"].includes(posted)) invalidQuery();
  const minPayText = text("minPay", 20), minPay = minPayText ? Number(minPayText) : browse ? 400 : 0;
  if (!Number.isFinite(minPay) || minPay < 0 || minPay > Number.MAX_SAFE_INTEGER / 100) invalidQuery();
  const matterId = text("matterId", 24); if (matterId && !/^[a-f\d]{24}$/i.test(matterId)) invalidQuery();
  return { page, limit, sort, deadline, posted, minPay, matterId: matterId.toLowerCase(), practice: text("practice").toLowerCase(), state: normalizeStateCode(text("state")), defaultState: browse && query.state === undefined };
}

function listingAmount(listing) {
  for (const field of ["remainingAmount", "lockedTotalAmount", "totalAmount"]) {
    if (typeof listing[field] === "number" && Number.isFinite(listing[field])) return listing[field] / 100;
  }
  return Number(listing.budget) || 0;
}

function matchesFilters(listing, filters, now) {
  if (filters.practice && String(listing.practiceArea || "").trim().toLowerCase() !== filters.practice) return false;
  if (filters.state && normalizeStateCode(listing.state) !== filters.state) return false;
  if (listingAmount(listing) < filters.minPay) return false;
  const deadline = normalizeDateOnly(listing.deadlineDate), today = dateOnlyFromZonedInstant(now);
  if (filters.deadline === "none" && deadline) return false;
  if (["7_days", "30_days"].includes(filters.deadline) && (!deadline || deadline < today || deadline > addCalendarDays(today, filters.deadline === "7_days" ? 7 : 30))) return false;
  const days = filters.posted === "7_days" ? 7 : filters.posted === "30_days" ? 30 : 0;
  const createdAt = new Date(listing.createdAt).getTime();
  if (days && (!listing.createdAt || !Number.isFinite(createdAt) || createdAt < now.getTime() - days * 86400000)) return false;
  return true;
}

async function enrichListings(items, viewer, { eligibility = true } = {}) {
  const ids = [...new Set(items.map(item => String(item.attorneyId || "")).filter(id => mongoose.isValidObjectId(id)))];
  const owners = ids.length ? await User.find({ _id: { $in: ids } }).select("firstName lastName lawFirm firmName profileImage avatarURL").lean() : [];
  const byId = new Map(owners.map(owner => [String(owner._id), owner]));
  const payoutReadiness = eligibility && items.length ? await resolveLivePayoutReadiness(viewer || {}) : null;
  const decisions = eligibility && (viewer?._id || viewer?.id) ? await require("../models/MatterRequirementDecision").find({paralegalId:viewer._id || viewer.id, matterKey:{$in:items.map(item => String(item.caseId || item.jobId || item._id))}}).lean() : [];
  const excluded = new Set(decisions.map(item => item.matterKey));
  return items.map(item => {
    const applicationEligibility = eligibility ? buildApplicationEligibility({ user: viewer, listing: item, duplicateApplication: Boolean(item.appliedAt), payoutReadiness }) : null;
    if (applicationEligibility && excluded.has(String(item.caseId || item.jobId || item._id))) { applicationEligibility.ready=false; applicationEligibility.allowed=false; applicationEligibility.blockers.push("requirements_not_met"); }
    if (applicationEligibility && item.applicationTargetVerified === false) {
      applicationEligibility.ready = false; applicationEligibility.allowed = false;
      applicationEligibility.blockers = [...applicationEligibility.blockers, "posting_verification_required"];
    }
    return { ...item, attorney: buildAttorneyPreview(byId.get(String(item.attorneyId || ""))), ...(eligibility ? { applicationEligibility } : {}) };
  });
}

const PROFILE_FIELDS = "role status email profileImage avatarURL stripeAccountId stripeOnboarded stripeChargesEnabled stripePayoutsEnabled availability availabilityDetails state location stateExperience practiceAreas yearsExperience";

async function readOpenListingPage(viewerId, query = {}, { browse = false } = {}) {
  const filters = parseDiscoveryQuery(query, { browse }), now = new Date();
  const viewer = await User.findById(viewerId).select(PROFILE_FIELDS).lean();
  if (!viewer) throw Object.assign(new Error("Paralegal profile not found."), { status: 404 });
  // The first unfiltered visit can use the saved state. Keep both selections in
  // one bounded pass, so an unavailable saved state falls back to all results.
  const defaultState = filters.defaultState && !filters.practice && !filters.deadline && !filters.posted && filters.minPay <= 400
    ? normalizeStateCode(viewer.state || viewer.location) : "";
  const all = { total: 0, items: [], lastPage: [] }, local = { total: 0, items: [], lastPage: [] };
  const add = (target, item) => {
    if (target.total % filters.limit === 0) target.lastPage = [];
    target.lastPage.push(item);
    if (target.total >= (filters.page - 1) * filters.limit && target.items.length < filters.limit) target.items.push(item);
    target.total += 1;
  };
  const states = new Set(), practices = new Set(); let availableTotal = 0, selected = null;
  for await (const listing of iterateOpenListings(viewerId, { sort: filters.sort })) {
    if (browse && (listing.appliedAt && !listing.relistRequestedAt || /job not found/i.test(listing.title))) continue;
    availableTotal += 1;
    const state = normalizeStateCode(listing.state), practice = String(listing.practiceArea || "").trim().toLowerCase();
    if (state) states.add(state); if (practice) practices.add(practice);
    if (filters.matterId && [listing.id, listing.caseId, listing.jobId].some(id => String(id || "") === filters.matterId)) selected = listing;
    if (!matchesFilters(listing, filters, now)) continue;
    add(all, listing); if (defaultState && state === defaultState) add(local, listing);
  }
  const useDefault = Boolean(defaultState && states.has(defaultState)), result = useDefault ? local : all;
  if (useDefault) filters.state = defaultState;
  delete filters.defaultState;
  const totalPages = Math.max(1, Math.ceil(result.total / filters.limit)), page = Math.min(filters.page, totalPages);
  const pageItems = page === filters.page ? result.items : result.lastPage;
  const enriched = await enrichListings([...pageItems, ...(selected ? [selected] : [])], viewer);
  return { viewerId: String(viewer._id), items: enriched.slice(0, pageItems.length), selected: selected ? enriched.at(-1) : null,
    total: result.total, availableTotal, page, limit: filters.limit, totalPages, hasMore: page < totalPages,
    filters: { ...filters, page }, facets: { states: [...states].sort(), practices: [...practices].sort() },
  };
}

async function readRecommendedListingPage(viewerId, query = {}) {
  const { limit } = parseDiscoveryQuery(query);
  const [viewer, exclusions] = await Promise.all([
    User.findById(viewerId).select(PROFILE_FIELDS).lean(), getHistoricalRecommendationExclusions(viewerId),
  ]);
  if (!viewer) throw Object.assign(new Error("Paralegal profile not found."), { status: 404 });
  const ranker = createRecommendationRanker(viewer, exclusions), best = []; let total = 0;
  for await (const listing of iterateOpenListings(viewerId)) {
    if (listing.applicationTargetVerified === false) continue;
    const ranked = ranker.rank(listing); if (!ranked) continue;
    total += 1;
    let low = 0, high = best.length;
    while (low < high) { const middle = (low + high) >>> 1; if (compareRankedRecommendations(best[middle], ranked) <= 0) low = middle + 1; else high = middle; }
    if (low < limit) { best.splice(low, 0, ranked); if (best.length > limit) best.pop(); }
  }
  return { hasMatchingProfile: ranker.hasMatchingProfile, total, limit,
    items: await enrichListings(best.map(value => value.item), viewer, { eligibility: false }),
  };
}

module.exports = { openDiscoveryCaseFilter, shapeListing, catalogPipeline, iterateOpenListings, readOpenListingPage, readRecommendedListingPage, parseDiscoveryQuery };
