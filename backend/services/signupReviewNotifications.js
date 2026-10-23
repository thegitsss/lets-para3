const { createHash } = require("crypto");
const Notice = require("../models/SignupReviewNotification");
const User = require("../models/User");
const accountEmails = require("../email/accountTemplates");
const emailHash = value => createHash("sha256").update(String(value).trim().toLowerCase()).digest("hex");

async function stage(user, session) {
  if (!session?.inTransaction()) throw new Error("Signup review mail requires the verification transaction.");
  await Notice.updateOne({ userId: user._id }, { $setOnInsert: { emailHash: emailHash(user.email) } }, { upsert: true, session });
}
async function prepare(notice) {
  const user = await User.findById(notice.userId).select("email emailVerified role status disabled deleted suspended").lean();
  if (!user || user.role !== "paralegal" || user.status !== "pending" || !user.emailVerified || user.disabled || user.deleted || user.suspended || emailHash(user.email) !== notice.emailHash) return null;
  return { to: user.email, ...accountEmails.applicationEmailVerified(user) };
}
const delivery = require("./emailNoticeDelivery").createEmailNoticeDelivery({ Notice, prepare, prefix: "signup-review" });
module.exports = { stage, prepare, ...delivery };
