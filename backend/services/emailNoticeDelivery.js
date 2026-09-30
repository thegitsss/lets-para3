const { randomUUID } = require("crypto");
const sendEmail = require("../utils/email");
const { revision } = require("./communicationRetry");
const { isDefiniteSmtpFailure } = require("../utils/smtpDeliveryOutcome");

// Delivery receipts describe provider acceptance, not inbox arrival. All
// callers keep their own authorization and obligation staging boundaries.
function createEmailNoticeDelivery({ Notice, prepare, prefix }) {
  if (!["file", "work", "payment", "withdrawal", "review", "application", "invitation", "pre-engagement", "posting"].includes(prefix)) throw new Error("Invalid email notice category.");
  async function processNotices({ limit = 20, shouldStop = () => false, onProgress = async () => {} } = {}) {
    if (shouldStop()) return 0;
    // A lost SMTP acknowledgement is not evidence of failure. Preserve it for
    // review rather than automatically sending a potentially duplicate email.
    await Notice.updateMany({ status: "sending", claimedAt: { $lt: new Date(Date.now() - 10 * 60000) } }, {
      $set: { status: "unknown", failure: "The worker stopped before delivery was confirmed. Check the mail provider's delivery record." },
    });
    let count = 0;
    while (count < limit && !shouldStop()) {
      const claim = randomUUID();
      const notice = await Notice.findOneAndUpdate({ status: { $in: ["pending", "failed"] }, attempts: { $lt: 5 }, nextAttemptAt: { $lte: new Date() } }, {
        $set: { status: "sending", claim, claimedAt: new Date() }, $inc: { attempts: 1 },
      }, { returnDocument: "after", sort: { nextAttemptAt: 1, createdAt: 1, _id: 1 } });
      if (!notice) break;
      count++;
      let status = "unknown", failure = "", acceptedAt, attempted = false;
      try {
        const email = await prepare(notice);
        if (!email) status = "skipped";
        else {
          attempted = true;
          const result = await sendEmail(email.to, email.subject, email.html, {
            throwOnError: true, headers: { "Auto-Submitted": "auto-generated" },
            messageId: `<lpc-${prefix}.${notice._id}@lets-paraconnect.com>`,
          });
          const includesRecipient = list => Array.isArray(list) && list.some(value => String(value?.address || value).toLowerCase() === email.to.toLowerCase());
          status = result?.disabled ? "disabled" : includesRecipient(result?.accepted) ? "accepted" : includesRecipient(result?.rejected) ? "failed" : "unknown";
          if (status === "accepted") acceptedAt = new Date();
          else if (status === "disabled") failure = "Email sending was disabled. This notice was not sent.";
          else if (status === "failed") failure = "The mail provider rejected this attempt.";
          else failure = "Delivery could not be confirmed. Check the mail provider's delivery record.";
        }
      } catch (error) {
        const definite = isDefiniteSmtpFailure(error, attempted);
        status = definite ? "failed" : "unknown";
        failure = definite ? (attempted ? "The mail provider rejected this attempt." : "The notice could not be checked before sending. The worker will retry.") : "Delivery could not be confirmed. Check the mail provider's delivery record.";
      }
      // If this acknowledgement write fails, the retained sending claim becomes
      // unknown on recovery. Do not send again in this invocation.
      await Notice.updateOne({ _id: notice._id, claim, status: "sending" }, {
        $set: { status, failure, ...(acceptedAt ? { acceptedAt } : {}), nextAttemptAt: new Date(Date.now() + Math.min(60, 2 ** notice.attempts) * 60000) },
      });
      await onProgress();
    }
    return count;
  }

  async function noticeStatus() {
    const [counts, recent] = await Promise.all([
      Notice.aggregate([{ $group: { _id: "$status", count: { $sum: 1 } } }]),
      Notice.find({ status: { $in: ["failed", "unknown", "disabled"] } }).sort({ updatedAt: -1, _id: -1 }).limit(10).select(`status attempts failure updatedAt claim caseId fileId${["application", "invitation", "pre-engagement", "posting"].includes(prefix) ? " kind" : ""}`).lean(),
    ]);
    return { counts: Object.fromEntries(counts.map(row => [row._id, row.count])), recent: recent.map(({ claim, ...record }) => ({ ...record, revision: revision({ ...record, claim }) })) };
  }
  return { processNotices, noticeStatus };
}
module.exports = { createEmailNoticeDelivery };
