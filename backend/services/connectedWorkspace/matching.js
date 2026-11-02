"use strict";
const crypto = require("node:crypto");
const { z } = require("zod");
const User = require("../../models/User");
const Case = require("../../models/Case");
const Vector = require("../../models/ParalegalSearchVector");
const Decision = require("../../models/MatterRequirementDecision");
const { getBlockedUserIds } = require("../../utils/blocks");
const { applyPublicParalegalFilter, resolveParalegalProfileFields } = require("../../utils/paralegalProfile");
const { effectiveAvailability, buildEffectiveAvailableClause } = require("../../utils/availability");
const { getOpenAIClient } = require("../../ai/config");
const { resolveExperienceRequirement } = require("../experienceRequirement");
const { actor } = require("../matterFileWrites");
const id = value => String(value?._id || value || "");
const fail = (status, message) => { throw Object.assign(new Error(message), { status, publicCode: "MATCH_SEARCH_UNAVAILABLE" }); };
const requestSchema = z.object({
  query: z.string().trim().min(3).max(1500),
  caseId: z.string().regex(/^[a-f0-9]{24}$/i).optional(),
  availableOnly: z.boolean().default(false),
  minimumYears: z.number().int().min(0).max(80).default(0),
  requiredSkills: z.array(z.string().trim().min(1).max(120)).max(12).default([]),
}).strict();
// These fields already form the directory's public professional projection.
// Resumes, contact details, private work, photos and protected attributes never
// enter the embedding request or the evidence returned to the attorney.
const PROFILE_FIELDS = "_id firstName lastName bio about practiceAreas specialties skills bestFor experience yearsExperience location state availability availabilityDetails updatedAt";
const stopWords = new Set("a an the i we need someone who has have with and or for to of in on can could would please paralegal work working this that my our their me is be by from".split(" "));
const concepts = [
  ["discovery", "interrogatories", "interrogatory", "requests for production", "document requests", "rpd"],
  ["chronology", "chronologies", "timeline", "timelines"],
  ["real estate", "conveyancing", "title", "closing"],
  ["estate planning", "wills", "trusts"],
  ["probate", "estate administration"],
  ["litigation", "lawsuit", "pleadings"],
];
const normalize = value => String(value || "").toLowerCase().normalize("NFKC").replace(/[^\p{L}\p{N}+#]+/gu, " ").trim();
function tokens(value) { return [...new Set(normalize(value).split(/\s+/).filter(word => word.length > 1 && !stopWords.has(word)))]; }
function evidenceFields(profile) {
  const resolved = resolveParalegalProfileFields(profile);
  const rows = [];
  const add = (field, value) => {
    if (typeof value === "string" && value.trim()) rows.push({ field, text: value.trim().slice(0, 1500), evidenceType: "self_reported" });
  };
  add("About", resolved.bio);
  for (const value of resolved.practiceAreas) add("Practice area", value);
  for (const value of profile.skills || []) add("Skill", value);
  for (const value of profile.bestFor || []) add("Best for", value);
  for (const value of Array.isArray(profile.experience) ? profile.experience : []) {
    if (typeof value === "string") add("Experience", value);
    else for (const field of ["title", "description", "responsibilities"]) add("Experience", value?.[field]);
  }
  return rows.slice(0, 65);
}
function profileText(profile) { return evidenceFields(profile).map(row => row.field + ": " + row.text).join("\n").slice(0, 8000); }
function lexicalScore(query, profile) {
  const words = tokens(query);
  const rows = evidenceFields(profile);
  const expanded = new Set(words);
  const normalizedQuery = normalize(query);
  for (const group of concepts) if (group.some(term => normalizedQuery.includes(term))) for (const term of group) for (const word of tokens(term)) expanded.add(word);
  const scored = rows.map(row => {
    const text = normalize(row.text);
    const direct = words.filter(word => (" " + text + " ").includes(" " + word + " ")).length;
    const related = [...expanded].filter(word => (" " + text + " ").includes(" " + word + " ")).length;
    return { ...row, relevance: direct * 3 + related };
  }).filter(row => row.relevance > 0).sort((a, b) => b.relevance - a.relevance);
  return { score: scored.reduce((sum, row) => sum + row.relevance, 0), evidence: scored.slice(0, 4).map(row => ({ field: row.field, text: row.text, evidenceType: row.evidenceType })) };
}
function cosine(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || !a.length || a.length !== b.length || !a.every(Number.isFinite) || !b.every(Number.isFinite)) return 0;
  let dot = 0, aa = 0, bb = 0;
  for (let index = 0; index < a.length; index++) { dot += a[index] * b[index]; aa += a[index] ** 2; bb += b[index] ** 2; }
  return aa && bb ? dot / Math.sqrt(aa * bb) : 0;
}
async function semanticScores(query, profiles) {
  const client = getOpenAIClient();
  if (!client || !profiles.length) return null;
  await Vector.init();
  const model = process.env.OPENAI_MATCH_EMBEDDING_MODEL || "text-embedding-3-small";
  const hashes = new Map(profiles.map(profile => [id(profile), crypto.createHash("sha256").update(profileText(profile)).digest("hex")]));
  const cached = await Vector.find({ userId: { $in: profiles.map(profile => profile._id) }, model }).select("+embedding").lean();
  const byId = new Map(cached.filter(row => row.profileHash === hashes.get(id(row.userId))).map(row => [id(row.userId), row.embedding]));
  const missing = profiles.filter(profile => !byId.has(id(profile)));
  // One bounded provider batch warms current profiles; stale vectors are never
  // used. Mongo stores vectors only, never a second copy of resume or bio text.
  const queryResponse = await client.embeddings.create({ model, input: [query], encoding_format: "float" }, { timeout: 15000, maxRetries: 0 });
  const queryVector = queryResponse.data?.find(row => row.index === 0)?.embedding;
  if (!Array.isArray(queryVector) || !queryVector.length || !queryVector.every(Number.isFinite)) throw new Error("Invalid search embedding");
  for (let offset = 0; offset < missing.length; offset += 24) {
    const batch = missing.slice(offset, offset + 24);
    const response = await client.embeddings.create({ model, input: batch.map(profileText), encoding_format: "float" }, { timeout: 15000, maxRetries: 0 });
    for (let index = 0; index < batch.length; index++) {
      const embedding = response.data?.find(row => row.index === index)?.embedding;
      if (!Array.isArray(embedding) || embedding.length !== queryVector.length || !embedding.every(Number.isFinite)) throw new Error("Invalid profile embedding");
      const profile = batch[index];
      byId.set(id(profile), embedding);
      await Vector.updateOne({ userId: profile._id }, { $set: { profileHash: hashes.get(id(profile)), model, embedding } }, { upsert: true });
    }
  }
  return new Map(profiles.map(profile => [id(profile), cosine(queryVector, byId.get(id(profile)))]));
}
async function allowedFilter(req, input) {
  let blocked = await getBlockedUserIds(req.user.id);
  const filter = { role: "paralegal", status: "approved", disabled: { $ne: true }, deleted: { $ne: true }, "preferences.hideProfile": { $ne: true } };
  applyPublicParalegalFilter(filter);
  let requirements = [];
  let minimum = input.minimumYears;
  if (input.caseId) {
    const matter = await Case.findOne({ _id: input.caseId, $or: [{ attorney: req.user.id }, { attorneyId: req.user.id }] }).lean();
    if (!matter || matter.purgedAt || (matter.attorney && matter.attorneyId && id(matter.attorney) !== id(matter.attorneyId))) fail(404, "This Matter is unavailable.");
    requirements = matter.requirements || [];
    minimum = Math.max(minimum, resolveExperienceRequirement(matter).minimumYears);
    const declined = await Decision.find({ matterKey: input.caseId }).select("paralegalId").lean();
    blocked = [...blocked, ...declined.map(row => row.paralegalId)];
  }
  if (blocked.length) filter._id = { $nin: blocked };
  if (minimum) filter.yearsExperience = { $gte: minimum };
  if (input.availableOnly) filter.$and.push(buildEffectiveAvailableClause(), { $or: [{ availability: { $type: "string", $regex: /\S/ } }, { "availabilityDetails.updatedAt": { $type: "date" } }] });
  return { filter, requirements };
}
async function search(req) {
  await actor(req);
  const parsed = requestSchema.safeParse(req.body);
  if (!parsed.success) fail(400, "Describe the work in 3–1,500 characters and check your search filters.");
  const input = parsed.data;
  const { filter, requirements } = await allowedFilter(req, input);
  const docs = await User.find(filter).sort({ updatedAt: -1, _id: 1 }).limit(501).select(PROFILE_FIELDS).lean();
  if (docs.length > 500) fail(413, "Narrow the search with availability or experience filters.");
  const profiles = docs.filter(profile => input.requiredSkills.every(skill => (profile.skills || []).some(value => normalize(value) === normalize(skill))));
  let semantic = null, mode = "profile_evidence", note = "";
  try { semantic = await semanticScores(input.query, profiles); if (semantic) mode = "semantic_and_profile_evidence"; }
  catch { note = "Meaning-based ranking is unavailable. These results use matching words and related work terms from profiles."; }
  const ranked = profiles.map(profile => {
    const lexical = lexicalScore(input.query, profile);
    const similarity = semantic?.get(id(profile)) || 0;
    return { profile, lexical, similarity, score: lexical.score + Math.max(0, similarity) * 20 };
  }).filter(row => row.lexical.score > 0 || row.similarity >= 0.35).sort((a, b) => b.score - a.score || id(a.profile).localeCompare(id(b.profile))).slice(0, 20);
  // Re-evaluate account visibility, blocking and requirements after external
  // processing. An old vector can never grant profile access.
  const refreshed = await allowedFilter(req, input);
  await actor(req);
  const visible = await User.find({ $and: [refreshed.filter, { _id: { $in: ranked.map(row => row.profile._id) } }] }).select(PROFILE_FIELDS).lean();
  const current = new Map(visible.map(profile => [id(profile), profile]));
  const items = ranked.flatMap(row => {
    const profile = current.get(id(row.profile));
    if (!profile || profileText(profile) !== profileText(row.profile) || input.requiredSkills.some(skill => !(profile.skills || []).some(value => normalize(value) === normalize(skill)))) return [];
    const availabilityKnown = Boolean(profile.availability || profile.availabilityDetails?.updatedAt);
    return [{
      id: id(profile), name: [profile.firstName, profile.lastName].filter(Boolean).join(" ") || "Paralegal",
      location: profile.location || profile.state || "", yearsExperience: Number.isFinite(profile.yearsExperience) ? profile.yearsExperience : null,
      availability: availabilityKnown ? effectiveAvailability(profile).availability : "Availability not confirmed",
      availabilityNote: "Self-reported; confirm availability before engaging.",
      evidence: row.lexical.evidence.length ? row.lexical.evidence : evidenceFields(profile).slice(0, 2),
      matchBasis: row.lexical.evidence.length ? "Relevant statements in the saved profile" : "Related profile content; review the evidence",
      requirements: requirements.map(text => ({ text, state: "confirmation_required" })),
      profileHref: "/attorney-v2.html#/paralegals/" + id(profile),
    }];
  });
  return { items, mode, note, query: input.query, requirementsNotice: requirements.length ? "Matches do not certify eligibility. Every mandatory Matter requirement must still be confirmed through LPC’s existing application process." : "Profile statements are self-reported. Recommendations do not select or hire anyone.", totalShown: items.length };
}
module.exports = { search, requestSchema, lexicalScore, evidenceFields, profileText, cosine, semanticScores, allowedFilter };
