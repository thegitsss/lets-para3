function hasNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function hasNonEmptyArray(value) {
  return Array.isArray(value) && value.filter(Boolean).length > 0;
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
  return (
    hasNonEmptyString(user.bio) &&
    hasNonEmptyArray(user.skills) &&
    hasNonEmptyArray(user.practiceAreas) &&
    hasNonEmptyString(user.resumeURL) &&
    (allowMissingPhoto || hasUploadedPhoto(user))
  );
}

function hasRequiredParalegalFieldsForPublic(user = {}) {
  return (
    hasNonEmptyString(user.bio) &&
    hasNonEmptyArray(user.skills) &&
    hasNonEmptyArray(user.practiceAreas) &&
    hasNonEmptyString(user.resumeURL) &&
    hasApprovedPhoto(user)
  );
}

function applyPublicParalegalFilter(filter) {
  if (!filter || typeof filter !== "object") return;
  const conditions = [
    { bio: { $nin: ["", null] } },
    { resumeURL: { $nin: ["", null] } },
    { "skills.0": { $exists: true } },
    { "practiceAreas.0": { $exists: true } },
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
  applyPublicParalegalFilter,
  hasApprovedPhoto,
  hasRequiredParalegalFieldsForPublic,
  hasRequiredParalegalFieldsForSave,
};
