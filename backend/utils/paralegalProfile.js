function hasNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function hasNonEmptyArray(value) {
  return Array.isArray(value) && value.some(hasNonEmptyString);
}

// Earlier admitted accounts retain About and specialties as their saved fields.
// Resolve them for reads; current writers synchronize both names when clearing.
function resolveParalegalProfileFields(user = {}) {
  return {
    bio: hasNonEmptyString(user.bio) ? user.bio : user.about || "",
    practiceAreas: hasNonEmptyArray(user.practiceAreas) ? user.practiceAreas : Array.isArray(user.specialties) ? user.specialties : [],
  };
}

function hasUploadedPhoto(user = {}) {
  const status = String(user.profilePhotoStatus || "").trim();
  const hasPending = hasNonEmptyString(user.pendingProfileImage);
  const hasApproved = hasNonEmptyString(user.profileImage) || hasNonEmptyString(user.avatarURL);
  if (status === "pending_review") return hasPending;
  if (status === "approved") return hasApproved;
  return hasPending || hasApproved;
}

function hasApprovedPhoto(user = {}) {
  const status = String(user.profilePhotoStatus || "").trim();
  const hasPending = hasNonEmptyString(user.pendingProfileImage);
  const hasApproved = hasNonEmptyString(user.profileImage) || hasNonEmptyString(user.avatarURL);
  return status === "approved" && hasApproved && !hasPending;
}

function hasRequiredParalegalFieldsForSave(user = {}, opts = {}) {
  const allowMissingPhoto = Boolean(opts.allowMissingPhoto);
  const fields = resolveParalegalProfileFields(user);
  return (
    hasNonEmptyString(fields.bio) &&
    hasNonEmptyArray(user.skills) &&
    hasNonEmptyArray(fields.practiceAreas) &&
    hasNonEmptyString(user.resumeURL) &&
    (allowMissingPhoto || hasUploadedPhoto(user))
  );
}

function hasRequiredParalegalFieldsForPublic(user = {}) {
  const fields = resolveParalegalProfileFields(user);
  return (
    hasNonEmptyString(fields.bio) &&
    hasNonEmptyArray(user.skills) &&
    hasNonEmptyArray(fields.practiceAreas) &&
    hasNonEmptyString(user.resumeURL) &&
    hasApprovedPhoto(user)
  );
}

function publicParalegalPracticeFilter(tokens) {
  const current = { practiceAreas: { $elemMatch: { $type: "string", $regex: /\S/ } } };
  return { $or: [
    { $and: [current, { practiceAreas: { $in: tokens } }] },
    { $and: [{ $nor: [current] }, { specialties: { $in: tokens } }] },
  ] };
}

function applyPublicParalegalFilter(filter) {
  if (!filter || typeof filter !== "object") return;
  const conditions = [
    { $or: [{ bio: { $type: "string", $regex: /\S/ } }, { about: { $type: "string", $regex: /\S/ } }] },
    { resumeURL: { $type: "string", $regex: /\S/ } },
    { skills: { $elemMatch: { $type: "string", $regex: /\S/ } } },
    { $or: [{ practiceAreas: { $elemMatch: { $type: "string", $regex: /\S/ } } }, { specialties: { $elemMatch: { $type: "string", $regex: /\S/ } } }] },
    { profilePhotoStatus: "approved" },
    { pendingProfileImage: { $in: ["", null] } },
    {
      $or: [
        { profileImage: { $nin: ["", null] } },
        { avatarURL: { $nin: ["", null] } },
      ],
    },
  ];
  if (!Array.isArray(filter.$and)) {
    filter.$and = [];
  }
  filter.$and.push(...conditions);
}

module.exports = {
  resolveParalegalProfileFields,
  publicParalegalPracticeFilter,
  applyPublicParalegalFilter,
  hasApprovedPhoto,
  hasRequiredParalegalFieldsForPublic,
  hasRequiredParalegalFieldsForSave,
};
