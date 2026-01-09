const Block = require("../models/Block");

const BLOCKED_MESSAGE =
  "This action is unavailable because one of the users has blocked the other.";

const normalizeId = (val) => (val ? String(val) : "");

function isBlockableRole(role) {
  const normalized = String(role || "").toLowerCase();
  return normalized === "attorney" || normalized === "paralegal";
}

function isBlockPairAllowed(roleA, roleB) {
  const a = String(roleA || "").toLowerCase();
  const b = String(roleB || "").toLowerCase();
  return isBlockableRole(a) && isBlockableRole(b) && a !== b;
}

async function isBlockedBetween(userId, otherId) {
  const a = normalizeId(userId);
  const b = normalizeId(otherId);
  if (!a || !b || a === b) return false;
  const existing = await Block.findOne({
    $or: [
      { blockerId: a, blockedId: b },
      { blockerId: b, blockedId: a },
    ],
  })
    .select("_id")
    .lean();
  return !!existing;
}

async function getBlockedUserIds(userId) {
  const id = normalizeId(userId);
  if (!id) return [];
  const blocks = await Block.find({
    $or: [{ blockerId: id }, { blockedId: id }],
  })
    .select("blockerId blockedId")
    .lean();
  const ids = new Set();
  blocks.forEach((block) => {
    const blocker = normalizeId(block.blockerId);
    const blocked = normalizeId(block.blockedId);
    if (blocker === id && blocked) ids.add(blocked);
    if (blocked === id && blocker) ids.add(blocker);
  });
  return [...ids];
}

module.exports = {
  BLOCKED_MESSAGE,
  isBlockedBetween,
  getBlockedUserIds,
  isBlockableRole,
  isBlockPairAllowed,
};
