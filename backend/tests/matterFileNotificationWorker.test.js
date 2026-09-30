const net = require("net"), path = require("path"), crypto = require("crypto");
const { execFile } = require("child_process"), { promisify } = require("util");
const { connect, clearDatabase, closeDatabase } = require("./helpers/db");
const { readReadyState } = require("./helpers/mongoHarnessState");
const Notice = require("../models/MatterFileNotification");
const WorkNotice = require("../models/MatterWorkNotification");
const PaymentNotice = require("../models/MatterPaymentNotification");
const WithdrawalNotice = require("../models/MatterWithdrawalNotification");
const User = require("../models/User"), Case = require("../models/Case"), CaseFile = require("../models/CaseFile"), Upload = require("../models/MatterFileUpload");
const InvitationNotice = require('../models/MatterInvitationNotification');
// Register the worker's collections before the parent harness initializes them.
require("../scripts/admin-communications-worker");
let server, port, messages, rejectRecipients, loseAcknowledgement, notice;
const sockets = new Set();
beforeAll(async () => {
  await connect();
  server = net.createServer(socket => {
    sockets.add(socket); socket.on("close", () => sockets.delete(socket)); socket.setEncoding("utf8"); socket.write("220 localhost LPC synthetic SMTP\r\n");
    let buffer = "", data = false, message = [];
    socket.on("data", chunk => {
      buffer += chunk; let end;
      while ((end = buffer.indexOf("\r\n")) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 2);
        if (data) {
          if (line === ".") {
            data = false; messages.push(message.join("\r\n")); message = [];
            if (loseAcknowledgement) socket.destroy(); else socket.write("250 Message accepted\r\n");
          } else message.push(line.startsWith("..") ? line.slice(1) : line);
        } else if (/^EHLO|^HELO/.test(line)) socket.write("250 localhost\r\n");
        else if (/^MAIL FROM/.test(line)) socket.write("250 OK\r\n");
        else if (/^RCPT TO/.test(line)) socket.write(rejectRecipients ? "550 Recipient rejected\r\n" : "250 OK\r\n");
        else if (line === "DATA") { data = true; socket.write("354 End with dot\r\n"); }
        else if (line === "QUIT") socket.end("221 Goodbye\r\n");
        else socket.write("250 OK\r\n");
      }
    });
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  port = server.address().port;
}, 120000);
afterAll(async () => { for (const socket of sockets) socket.destroy(); if (server?.listening) await new Promise(resolve => server.close(resolve)); await closeDatabase(); });
beforeEach(async () => {
  await clearDatabase(); messages = []; rejectRecipients = false; loseAcknowledgement = false;
  const [attorney, paralegal] = await User.create(["attorney", "paralegal"].map(role => ({ firstName: "Synthetic", lastName: role, email: `${role}@worker.test`, password: "Synthetic123!", role, status: "approved" })));
  const matter = await Case.create({ attorney: attorney._id, attorneyId: attorney._id, paralegal: paralegal._id, paralegalId: paralegal._id, title: "Synthetic lease review", details: "Synthetic", practiceArea: "contract law", state: "New York", status: "in progress", escrowStatus: "funded", escrowIntentId: "pi_worker_test" });
  const file = await CaseFile.create({ caseId: matter._id, userId: attorney._id, originalName: "Synthetic exhibit.txt", storageKey: `cases/${matter._id}/documents/synthetic.txt`, mimeType: "text/plain", size: 16, uploadedByRole: "attorney", status: "pending_review", version: 1 });
  const upload = await Upload.create({ caseId: matter._id, ownerId: attorney._id, requestId: crypto.randomUUID(), fingerprint: "a".repeat(64), fileId: file._id, kind: "upload", status: "recorded", claimToken: crypto.randomUUID(), leaseUntil: new Date(), recordedAt: new Date() });
  notice = await Notice.create({ _id: upload._id, userId: paralegal._id, actorUserId: attorney._id, caseId: matter._id, fileId: file._id, fileVersion: 1 });
});
async function launch() {
  // Only the loopback database and SMTP peer are reachable through this worker's
  // configured providers. No inherited SMTP, storage, mailbox or AI credentials.
  const env = Object.fromEntries(["HOME", "TMPDIR", "PATH", "LANG"].filter(key => process.env[key]).map(key => [key, process.env[key]]));
  Object.assign(env, { NODE_ENV: "test", MONGO_URI: readReadyState().uri.replace(/\/$/, "") + "/jest", DATA_ENCRYPTION_KEY: process.env.DATA_ENCRYPTION_KEY, EMAIL_DISABLE: "false", SMTP_HOST: "127.0.0.1", SMTP_PORT: String(port), SMTP_SECURE: "false", SMTP_FROM_EMAIL: "sender@example.invalid", SMTP_FROM_NAME: "Synthetic LPC", EMAIL_SKIP_VERIFY: "true", AWS_EC2_METADATA_DISABLED: "true" });
  const run = "require('./scripts/admin-communications-worker').main().catch(() => { process.exitCode = 1; });";
  // Programmatic entry avoids loading a developer's .env when this test is run
  // from a regular checkout. It still executes the real worker's main loop.
  await promisify(execFile)(process.execPath, ["-e", run, "--", "--once"], { cwd: path.resolve(__dirname, ".."), env, timeout: 60000 });
}
test("fresh worker processes recover a saved email once using LPC's actual SMTP transport", async () => {
  await launch(); expect((await Notice.findById(notice._id)).status).toBe("accepted");
  expect(messages).toHaveLength(1); expect(messages[0]).toContain(`Message-ID: <lpc-file.${notice._id}@lets-paraconnect.com>`);
  // SMTP quoted-printable soft wraps do not change the visible filename.
  expect(messages[0].replace(/=\r?\n/g, "")).toContain("Synthetic exhibit.txt");
  await launch(); expect(messages).toHaveLength(1); expect((await Notice.findById(notice._id)).attempts).toBe(1);
}, 120000);
test("a definite transport rejection is recovered by the next worker after its backoff", async () => {
  rejectRecipients = true; await launch(); expect((await Notice.findById(notice._id)).status).toBe("failed"); expect(messages).toHaveLength(0);
  rejectRecipients = false; await Notice.updateOne({ _id: notice._id }, { $set: { nextAttemptAt: new Date(0) } });
  await launch(); expect((await Notice.findById(notice._id)).status).toBe("accepted"); expect(messages).toHaveLength(1);
}, 120000);
test("lost SMTP acceptance stays unknown after a fresh worker restart and never sends twice automatically", async () => {
  loseAcknowledgement = true; await launch(); expect(messages).toHaveLength(1); expect((await Notice.findById(notice._id)).status).toBe("unknown");
  loseAcknowledgement = false; await launch(); expect(messages).toHaveLength(1); expect((await Notice.findById(notice._id)).status).toBe("unknown");
}, 120000);

test('a fresh worker delivers a paralegal submission to the attorney with its protected file link', async () => {
  const attorneyId = notice.actorUserId, paralegalId = notice.userId;
  await CaseFile.updateOne({ _id: notice.fileId }, { $set: { userId: paralegalId, uploadedByRole: 'paralegal' } });
  await Upload.updateOne({ _id: notice._id }, { $set: { ownerId: paralegalId } });
  await Notice.updateOne({ _id: notice._id }, { $set: { userId: attorneyId, actorUserId: paralegalId } });
  await launch(); expect((await Notice.findById(notice._id)).status).toBe('accepted'); expect(messages).toHaveLength(1);
  const decoded = messages[0].replace(/=\r\n/g, '').replace(/=([0-9a-f]{2})/gi, (_, pair) => String.fromCharCode(parseInt(pair, 16)));
  expect(decoded).toContain('To: attorney@worker.test');
  expect(decoded).toContain(`/case-detail.html?caseId=${notice.caseId}&amp;tab=files&amp;fileId=${notice.fileId}`);
  await launch(); expect(messages).toHaveLength(1);
}, 120000);

async function prepareWorkEmail() {
  await Notice.deleteOne({ _id: notice._id });
  const hiredAt = new Date();
  await Case.updateOne({ _id: notice.caseId }, { $set: { hiredAt, fundingIntegrityStatus: "verified" } });
  return WorkNotice.create({ caseId: notice.caseId, userId: notice.userId, attorneyId: notice.actorUserId, hiredAt });
}
test("a fresh worker delivers saved work email once with the current Matter destination", async () => {
  const work = await prepareWorkEmail();
  await launch(); expect((await WorkNotice.findById(work._id)).status).toBe("accepted"); expect(messages).toHaveLength(1);
  const decoded = messages[0].replace(/=\r\n/g, "").replace(/=([0-9a-f]{2})/gi, (_, pair) => String.fromCharCode(parseInt(pair, 16)));
  expect(decoded).toContain(`Message-ID: <lpc-work.${work._id}@lets-paraconnect.com>`);
  expect(decoded).toContain("To: paralegal@worker.test");
  expect(decoded).toContain(`/case-detail.html?caseId=${work.caseId}&amp;tab=work`);
  await launch(); expect(messages).toHaveLength(1); expect((await WorkNotice.findById(work._id)).attempts).toBe(1);
}, 120000);
test("work email recovers a definite SMTP rejection after worker restart", async () => {
  const work = await prepareWorkEmail(); rejectRecipients = true;
  await launch(); expect((await WorkNotice.findById(work._id)).status).toBe("failed"); expect(messages).toHaveLength(0);
  rejectRecipients = false; await WorkNotice.updateOne({ _id: work._id }, { $set: { nextAttemptAt: new Date(0) } });
  await launch(); expect((await WorkNotice.findById(work._id)).status).toBe("accepted"); expect(messages).toHaveLength(1);
}, 120000);
test("work email never resends automatically after losing SMTP acceptance", async () => {
  const work = await prepareWorkEmail(); loseAcknowledgement = true;
  await launch(); expect((await WorkNotice.findById(work._id)).status).toBe("unknown"); expect(messages).toHaveLength(1);
  loseAcknowledgement = false; await launch(); expect((await WorkNotice.findById(work._id)).status).toBe("unknown"); expect(messages).toHaveLength(1);
}, 120000);

async function preparePaymentEmail() {
  await Notice.deleteOne({ _id: notice._id });
  await Case.updateOne({ _id: notice.caseId }, { $set: { status: "open", escrowStatus: "awaiting_funding", paymentStatus: "requires_action", paymentIntentId: "pi_worker_test" } });
  return PaymentNotice.create({ caseId: notice.caseId, userId: notice.actorUserId, paymentIntentId: "pi_worker_test", paymentStatus: "requires_action" });
}
test("a fresh worker delivers a saved payment action once with its funding destination", async () => {
  const payment = await preparePaymentEmail(); await launch();
  expect((await PaymentNotice.findById(payment._id)).status).toBe("accepted"); expect(messages).toHaveLength(1);
  const decoded = messages[0].replace(/=\r\n/g, "").replace(/=([0-9a-f]{2})/gi, (_, pair) => String.fromCharCode(parseInt(pair, 16)));
  expect(decoded).toContain(`Message-ID: <lpc-payment.${payment._id}@lets-paraconnect.com>`);
  expect(decoded).toContain("To: attorney@worker.test");
  expect(decoded).toContain(`/case-detail.html?caseId=${payment.caseId}&amp;tab=financials`);
  await launch(); expect(messages).toHaveLength(1); expect((await PaymentNotice.findById(payment._id)).attempts).toBe(1);
}, 120000);
test("payment email recovers a definite SMTP rejection after worker restart", async () => {
  const payment = await preparePaymentEmail(); rejectRecipients = true;
  await launch(); expect((await PaymentNotice.findById(payment._id)).status).toBe("failed"); expect(messages).toHaveLength(0);
  rejectRecipients = false; await PaymentNotice.updateOne({ _id: payment._id }, { $set: { nextAttemptAt: new Date(0) } });
  await launch(); expect((await PaymentNotice.findById(payment._id)).status).toBe("accepted"); expect(messages).toHaveLength(1);
}, 120000);
test("payment email never resends automatically after losing SMTP acceptance", async () => {
  const payment = await preparePaymentEmail(); loseAcknowledgement = true;
  await launch(); expect((await PaymentNotice.findById(payment._id)).status).toBe("unknown"); expect(messages).toHaveLength(1);
  loseAcknowledgement = false; await launch(); expect((await PaymentNotice.findById(payment._id)).status).toBe("unknown"); expect(messages).toHaveLength(1);
}, 120000);

async function prepareWithdrawalEmail(kind = "request") {
  await Notice.deleteOne({ _id: notice._id });
  const withdrawnAt = new Date();
  await Case.updateOne({ _id: notice.caseId }, { $set: { status: "paused", pausedReason: "paralegal_withdrew", pausedAt: withdrawnAt, paralegal: null, paralegalId: null, withdrawnParalegalId: notice.userId } });
  if (kind === "partial") await Case.updateOne({ _id: notice.caseId }, { $set: { payoutFinalizedAt: withdrawnAt, payoutFinalizedType: "partial_attorney", partialPayoutAmount: 0 } });
  return WithdrawalNotice.create({ caseId: notice.caseId, userId: notice.actorUserId, attorneyId: notice.actorUserId, paralegalId: notice.userId, withdrawnAt, kind, eventAt: withdrawnAt, outcome: kind === "request" ? "awaiting_attorney_decision" : "zero_recorded" });
}
test.each(["request", "partial"])("a fresh worker delivers a saved withdrawal %s once with its decision destination", async kind => {
  const withdrawal = await prepareWithdrawalEmail(kind); await launch();
  expect((await WithdrawalNotice.findById(withdrawal._id)).status).toBe("accepted"); expect(messages).toHaveLength(1);
  const decoded = messages[0].replace(/=\r\n/g, "").replace(/=([0-9a-f]{2})/gi, (_, pair) => String.fromCharCode(parseInt(pair, 16)));
  expect(decoded).toContain(`Message-ID: <lpc-withdrawal.${withdrawal._id}@lets-paraconnect.com>`);
  expect(decoded).toContain("To: attorney@worker.test");
  expect(decoded).toContain(kind === "request" ? "Paralegal withdrawal" : "Withdrawal decision recorded");
  expect(decoded).toContain(`/case-detail.html?caseId=${withdrawal.caseId}&amp;tab=financials`);
  await launch(); expect(messages).toHaveLength(1); expect((await WithdrawalNotice.findById(withdrawal._id)).attempts).toBe(1);
}, 120000);
test.each(["request", "partial"])("withdrawal %s email recovers a definite SMTP rejection after worker restart", async kind => {
  const withdrawal = await prepareWithdrawalEmail(kind); rejectRecipients = true;
  await launch(); expect((await WithdrawalNotice.findById(withdrawal._id)).status).toBe("failed"); expect(messages).toHaveLength(0);
  rejectRecipients = false; await WithdrawalNotice.updateOne({ _id: withdrawal._id }, { $set: { nextAttemptAt: new Date(0) } });
  await launch(); expect((await WithdrawalNotice.findById(withdrawal._id)).status).toBe("accepted"); expect(messages).toHaveLength(1);
}, 120000);
test.each(["request", "partial"])("withdrawal %s email never resends automatically after losing SMTP acceptance", async kind => {
  const withdrawal = await prepareWithdrawalEmail(kind); loseAcknowledgement = true;
  await launch(); expect((await WithdrawalNotice.findById(withdrawal._id)).status).toBe("unknown"); expect(messages).toHaveLength(1);
  loseAcknowledgement = false; await launch(); expect((await WithdrawalNotice.findById(withdrawal._id)).status).toBe("unknown"); expect(messages).toHaveLength(1);
}, 120000);

async function prepareCompletionEmail(role) {
  await Notice.deleteOne({_id:notice._id});const at=new Date();
  await Case.updateOne({_id:notice.caseId},{$set:{totalAmount:10000,lockedTotalAmount:10000,status:"completed",archived:true,readOnly:true,completedAt:at,paralegalAccessRevokedAt:at,paymentReleased:true,payoutTransferId:"tr_worker_completion",payoutStatus:"paid",paidOutAt:at,stripeMode:"test"}});
  const payout=await require("../models/Payout").create({caseId:notice.caseId,paralegalId:notice.userId,amountPaid:8200,transferId:"tr_worker_completion",status:"paid",stripeMode:"test"});
  return PaymentNotice.create({kind:"completion",caseId:notice.caseId,userId:role==="attorney"?notice.actorUserId:notice.userId,payoutId:payout._id,transferId:payout.transferId,completedAt:at});
}
test.each(["attorney","paralegal"])("a fresh worker delivers the %s completion email once from retained payment evidence",async role=>{
 const completion=await prepareCompletionEmail(role);await launch();expect((await PaymentNotice.findById(completion._id)).status).toBe("accepted");expect(messages).toHaveLength(1);
 const decoded=messages[0].replace(/=\r\n/g,"").replace(/=([0-9a-f]{2})/gi,(_,pair)=>String.fromCharCode(parseInt(pair,16)));
 expect(decoded).toContain(`Message-ID: <lpc-payment.${completion._id}@lets-paraconnect.com>`);expect(decoded).toContain(`To: ${role}@worker.test`);expect(decoded).toContain("Matter completed");
 expect(decoded).toContain(role==="attorney"?`/case-detail.html?caseId=${completion.caseId}&amp;tab=financials`:`/dashboard-paralegal.html?highlightCase=${completion.caseId}#cases-completed`);
 await launch();expect(messages).toHaveLength(1);expect((await PaymentNotice.findById(completion._id)).attempts).toBe(1);
},120000);
test.each(["attorney","paralegal"])("a rejected %s completion email recovers after worker restart",async role=>{
 const completion=await prepareCompletionEmail(role);rejectRecipients=true;await launch();expect((await PaymentNotice.findById(completion._id)).status).toBe("failed");expect(messages).toHaveLength(0);
 rejectRecipients=false;await PaymentNotice.updateOne({_id:completion._id},{$set:{nextAttemptAt:new Date(0)}});await launch();expect((await PaymentNotice.findById(completion._id)).status).toBe("accepted");expect(messages).toHaveLength(1);
},120000);
test.each(["attorney","paralegal"])("unknown SMTP acceptance never automatically repeats the %s completion email",async role=>{
 const completion=await prepareCompletionEmail(role);loseAcknowledgement=true;await launch();expect((await PaymentNotice.findById(completion._id)).status).toBe("unknown");expect(messages).toHaveLength(1);
 loseAcknowledgement=false;await launch();expect((await PaymentNotice.findById(completion._id)).status).toBe("unknown");expect(messages).toHaveLength(1);
},120000);

async function prepareReviewEmail(role) {
  await Notice.deleteOne({ _id: notice._id });
  const Review = require("../models/MatterReviewNotification"), mongoose = require("mongoose"), openedAt = new Date(), disputeId = new mongoose.Types.ObjectId().toString();
  let userId = role === "attorney" ? notice.actorUserId : notice.userId;
  if (role === "admin") userId = (await User.create({ firstName: "Synthetic", lastName: "Admin", email: "admin@worker.test", password: "Synthetic123!", role, status: "approved" }))._id;
  await Case.updateOne({ _id: notice.caseId }, { $set: { status: "disputed", pausedReason: "dispute", disputes: [{ disputeId, raisedBy: notice.userId, message: "PRIVATE_REVIEW_DETAILS", status: "open", createdAt: openedAt }] } });
  const stored = await Case.collection.findOne({ _id: notice.caseId });
  return Review.create({ caseId: notice.caseId, userId, userRole: role, disputeId, openedAt: stored.disputes[0].createdAt });
}
for (const role of ["attorney", "paralegal", "admin"]) {
 test(`fresh workers deliver ${role} review email once through real local SMTP`, async () => {
  const Review = require("../models/MatterReviewNotification"), saved = await prepareReviewEmail(role);
  await launch(); expect((await Review.findById(saved._id)).status).toBe("accepted"); expect(messages).toHaveLength(1); expect(messages[0]).toContain(`Message-ID: <lpc-review.${saved._id}@lets-paraconnect.com>`); expect(messages[0]).not.toContain("PRIVATE_REVIEW_DETAILS");
  await launch(); expect(messages).toHaveLength(1);
 }, 120000);
 test(`a definite ${role} review email rejection retries after backoff`, async () => {
  const Review = require("../models/MatterReviewNotification"), saved = await prepareReviewEmail(role);
  rejectRecipients = true; await launch(); expect((await Review.findById(saved._id)).status).toBe("failed"); expect(messages).toHaveLength(0);
  rejectRecipients = false; await Review.updateOne({ _id: saved._id }, { $set: { nextAttemptAt: new Date(0) } }); await launch(); expect((await Review.findById(saved._id)).status).toBe("accepted"); expect(messages).toHaveLength(1);
 }, 120000);
 test(`unknown ${role} review email acceptance never automatically resends`, async () => {
  const Review = require("../models/MatterReviewNotification"), saved = await prepareReviewEmail(role);
  loseAcknowledgement = true; await launch(); expect((await Review.findById(saved._id)).status).toBe("unknown"); expect(messages).toHaveLength(1);
  loseAcknowledgement = false; await launch(); expect(messages).toHaveLength(1); expect((await Review.findById(saved._id)).status).toBe("unknown");
 }, 120000);
}

async function prepareResolutionEmail(role) {
 const saved = await prepareReviewEmail(role === 'attorney' ? 'attorney' : 'paralegal');
 const Review = require('../models/MatterReviewNotification'), Operation = require('../models/PaymentOperation'), Payout = require('../models/Payout');
 const resolvedAt = new Date(), operationKey = `dispute_settlement:${saved.caseId}:${saved.disputeId}`;
 const operation = await Operation.create({ caseId: saved.caseId, kind: 'dispute_settlement', operationKey, fingerprint: 'synthetic-worker-resolution', status: 'succeeded', evidenceStatus: 'verified', stripeTransferId: 'tr_worker_resolution', transferAmount: 32800 });
 await Payout.create({ caseId: saved.caseId, paralegalId: notice.userId, operationKey, transferId: 'tr_worker_resolution', amountPaid: 32800, status: 'paid' });
 const changes = { status: role === 'withdrawn' ? 'paused' : 'closed', pausedReason: role === 'withdrawn' ? 'paralegal_withdrew' : null, 'disputes.0.status': 'resolved', payoutStatus: 'paid', payoutTransferId: 'tr_worker_resolution', disputeSettlement: { disputeId: saved.disputeId, action: 'release_full', resolvedAt, transferId: 'tr_worker_resolution', refundId: '', payoutAmount: 32800, refundAmount: 0 } };
 if (role === 'withdrawn') Object.assign(changes, { paralegal: null, paralegalId: null, withdrawnParalegalId: notice.userId, paralegalAccessRevokedAt: resolvedAt });
 await Case.collection.updateOne({ _id: saved.caseId }, { $set: changes });
 await Review.updateOne({ _id: saved._id }, { $set: { kind: 'resolved', resolvedAt, action: 'release_full', operationId: operation._id } });
 return saved;
}
for (const role of ['attorney', 'paralegal', 'withdrawn']) {
 test(`fresh workers deliver ${role} decision email once through real local SMTP`, async () => {
  const Review = require('../models/MatterReviewNotification'), saved = await prepareResolutionEmail(role);
  await launch(); expect((await Review.findById(saved._id)).status).toBe('accepted'); expect(messages).toHaveLength(1);
  const decoded = messages[0].replace(/=\r\n/g, '').replace(/=([0-9a-f]{2})/gi, (_, pair) => String.fromCharCode(parseInt(pair, 16)));
  expect(decoded).toContain(`Message-ID: <lpc-review.${saved._id}@lets-paraconnect.com>`); expect(decoded).toContain('Review decision recorded'); expect(decoded).not.toContain('PRIVATE_REVIEW_DETAILS');
  expect(decoded).toContain(role === 'attorney' ? `/case-detail.html?caseId=${saved.caseId}&amp;tab=financials` : `/dashboard-paralegal.html?highlightCase=${saved.caseId}#cases-completed`);
  await launch(); expect(messages).toHaveLength(1);
 }, 120000);
 test(`a definite ${role} decision email rejection retries after backoff`, async () => {
  const Review = require('../models/MatterReviewNotification'), saved = await prepareResolutionEmail(role);
  rejectRecipients = true; await launch(); expect((await Review.findById(saved._id)).status).toBe('failed'); expect(messages).toHaveLength(0);
  rejectRecipients = false; await Review.updateOne({ _id: saved._id }, { $set: { nextAttemptAt: new Date(0) } }); await launch(); expect((await Review.findById(saved._id)).status).toBe('accepted'); expect(messages).toHaveLength(1);
 }, 120000);
 test(`unknown ${role} decision email acceptance never automatically resends`, async () => {
  const Review = require('../models/MatterReviewNotification'), saved = await prepareResolutionEmail(role);
  loseAcknowledgement = true; await launch(); expect((await Review.findById(saved._id)).status).toBe('unknown'); expect(messages).toHaveLength(1);
  loseAcknowledgement = false; await launch(); expect(messages).toHaveLength(1); expect((await Review.findById(saved._id)).status).toBe('unknown');
 }, 120000);
}


async function prepareOverdueEmail(role) {
  const saved = await prepareReviewEmail(role), Review = require('../models/MatterReviewNotification');
  const remindedAt = new Date(), deadlineAt = new Date(remindedAt.getTime() - 60000);
  await Case.collection.updateOne({ _id: saved.caseId }, { $set: { paralegal: null, paralegalId: null, withdrawnParalegalId: notice.userId, paralegalAccessRevokedAt: remindedAt, adminDisputeDeadlineAt: deadlineAt, adminDisputeOverdueNotifiedAt: remindedAt } });
  await Review.updateOne({ _id: saved._id }, { $set: { kind: 'overdue', deadlineAt, remindedAt } });
  return saved;
}
for (const role of ['attorney', 'paralegal']) {
 test(`fresh workers deliver ${role} overdue email once through real local SMTP`, async () => {
  const Review = require('../models/MatterReviewNotification'), saved = await prepareOverdueEmail(role);
  await launch(); expect((await Review.findById(saved._id)).status).toBe('accepted'); expect(messages).toHaveLength(1);
  const decoded = messages[0].replace(/=\r\n/g, '').replace(/=([0-9a-f]{2})/gi, (_, pair) => String.fromCharCode(parseInt(pair, 16)));
  expect(decoded).toContain(`Message-ID: <lpc-review.${saved._id}@lets-paraconnect.com>`); expect(decoded).toContain('LPC review still open'); expect(decoded).not.toContain('PRIVATE_REVIEW_DETAILS');
  expect(decoded).toContain(role === 'attorney' ? `/case-detail.html?caseId=${saved.caseId}&amp;tab=financials` : `/dashboard-paralegal.html?highlightCase=${saved.caseId}#cases-completed`);
  await launch(); expect(messages).toHaveLength(1);
 }, 120000);
 test(`a definite ${role} overdue email rejection retries after backoff`, async () => {
  const Review = require('../models/MatterReviewNotification'), saved = await prepareOverdueEmail(role);
  rejectRecipients = true; await launch(); expect((await Review.findById(saved._id)).status).toBe('failed'); expect(messages).toHaveLength(0);
  rejectRecipients = false; await Review.updateOne({ _id: saved._id }, { $set: { nextAttemptAt: new Date(0) } }); await launch(); expect((await Review.findById(saved._id)).status).toBe('accepted'); expect(messages).toHaveLength(1);
 }, 120000);
 test(`unknown ${role} overdue email acceptance never automatically resends`, async () => {
  const Review = require('../models/MatterReviewNotification'), saved = await prepareOverdueEmail(role);
  loseAcknowledgement = true; await launch(); expect((await Review.findById(saved._id)).status).toBe('unknown'); expect(messages).toHaveLength(1);
  loseAcknowledgement = false; await launch(); expect(messages).toHaveLength(1); expect((await Review.findById(saved._id)).status).toBe('unknown');
 }, 120000);
}

async function prepareTerminationReviewEmail() {
  const saved = await prepareReviewEmail('paralegal'), Review = require('../models/MatterReviewNotification'), at = new Date();
  await Case.updateOne({ _id: saved.caseId }, { $set: { terminationStatus: 'disputed', terminationDisputeId: saved.disputeId, terminationRequestedAt: at, paralegalAccessRevokedAt: at } });
  await Review.updateOne({ _id: saved._id }, { $set: { reviewContext: 'termination', terminationRequestedAt: at, accessRevokedAt: at } });
  return saved;
}
test('fresh workers deliver the retained termination review email once through real local SMTP', async () => {
  const Review = require('../models/MatterReviewNotification'), saved = await prepareTerminationReviewEmail();
  await launch(); expect((await Review.findById(saved._id)).status).toBe('accepted'); expect(messages).toHaveLength(1);
  expect(messages[0]).toContain(`Message-ID: <lpc-review.${saved._id}@lets-paraconnect.com>`); expect(messages[0]).not.toContain('PRIVATE_REVIEW_DETAILS');
  await launch(); expect(messages).toHaveLength(1);
}, 120000);
test('a definite termination review email rejection retries after backoff', async () => {
  const Review = require('../models/MatterReviewNotification'), saved = await prepareTerminationReviewEmail();
  rejectRecipients = true; await launch(); expect((await Review.findById(saved._id)).status).toBe('failed'); expect(messages).toHaveLength(0);
  rejectRecipients = false; await Review.updateOne({ _id: saved._id }, { $set: { nextAttemptAt: new Date(0) } }); await launch(); expect((await Review.findById(saved._id)).status).toBe('accepted'); expect(messages).toHaveLength(1);
}, 120000);
test('unknown termination review email acceptance never automatically resends', async () => {
  const Review = require('../models/MatterReviewNotification'), saved = await prepareTerminationReviewEmail();
  loseAcknowledgement = true; await launch(); expect((await Review.findById(saved._id)).status).toBe('unknown'); expect(messages).toHaveLength(1);
  loseAcknowledgement = false; await launch(); expect(messages).toHaveLength(1); expect((await Review.findById(saved._id)).status).toBe('unknown');
}, 120000);

async function prepareApplicationEmail() {
  await Notice.deleteOne({ _id: notice._id });
  await Case.updateOne({ _id: notice.caseId }, { $set: { status: 'open', paralegal: null, paralegalId: null } });
  const Job = require('../models/Job'), Application = require('../models/Application');
  const job = await Job.create({ title: 'River Street filing', description: 'Synthetic filing scope', practiceArea: 'immigration', caseId: notice.caseId, attorneyId: notice.actorUserId, budget: 500, status: 'open' });
  const application = await Application.create({ jobId: job._id, paralegalId: notice.userId, coverLetter: 'PRIVATE_APPLICATION_TEXT', status: 'submitted', syncStatus: 'synced', scopeSnapshot: { caseId: String(notice.caseId), title: job.title, capturedAt: new Date() }, statusHistory: [{ to: 'submitted', reason: 'applied', actorId: notice.userId }] });
  return require('../models/MatterApplicationNotification').create({ applicationId: application._id, submissionKey: require('../services/matterApplicationNotifications').submissionKey(application.toObject()), jobId: job._id, caseId: notice.caseId, userId: notice.actorUserId, paralegalId: notice.userId });
}

async function prepareInvitationEmail() {
  await Notice.deleteOne({ _id: notice._id });
  const at = new Date();
  const matter = await Case.findByIdAndUpdate(notice.caseId, { $set: {
    status: 'open', paralegal: null, paralegalId: null, totalAmount: 60000, lockedTotalAmount: 60000, amountLockedAt: at,
    invites: [{ paralegalId: notice.userId, status: 'pending', invitedAt: at, syncStatus: 'synced' }],
  } }, { returnDocument: 'after' }).lean();
  return InvitationNotice.create({ kind: 'sent', caseId: notice.caseId, ownerId: notice.actorUserId, actorUserId: notice.actorUserId,
    userId: notice.userId, paralegalId: notice.userId, invitationKey: require('../services/matterInvitationNotifications').invitationKey(matter, notice.actorUserId, notice.userId) });
}
test('a fresh worker delivers the retained invitation once through local SMTP', async () => {
  const saved = await prepareInvitationEmail(); await launch(); expect((await InvitationNotice.findById(saved._id)).status).toBe('accepted'); expect(messages).toHaveLength(1);
  const decoded = messages[0].replace(/=\r\n/g, '').replace(/=3D/g, '='); expect(decoded).toContain(`Message-ID: <lpc-invitation.${saved._id}@lets-paraconnect.com>`);
  expect(decoded).toContain('View invitation'); expect(decoded).toContain(`inviteCase=${saved.caseId}#home`); expect(decoded).toContain('does not assign the Matter to you.');
  await launch(); expect(messages).toHaveLength(1);
}, 120000);
test('an invitation email retries a definite SMTP rejection after worker restart', async () => {
  const saved = await prepareInvitationEmail(); rejectRecipients = true; await launch(); expect((await InvitationNotice.findById(saved._id)).status).toBe('failed'); expect(messages).toHaveLength(0);
  rejectRecipients = false; await InvitationNotice.updateOne({ _id: saved._id }, { $set: { nextAttemptAt: new Date(0) } }); await launch(); expect((await InvitationNotice.findById(saved._id)).status).toBe('accepted'); expect(messages).toHaveLength(1);
}, 120000);
test('unknown invitation email acceptance never automatically resends after restart', async () => {
  const saved = await prepareInvitationEmail(); loseAcknowledgement = true; await launch(); expect((await InvitationNotice.findById(saved._id)).status).toBe('unknown'); expect(messages).toHaveLength(1);
  loseAcknowledgement = false; await launch(); expect(messages).toHaveLength(1); expect((await InvitationNotice.findById(saved._id)).status).toBe('unknown');
}, 120000);
const ApplicationNotice = require('../models/MatterApplicationNotification');
test('a fresh worker delivers an application email once through real local SMTP', async () => {
  const saved = await prepareApplicationEmail(); await launch();
  expect((await ApplicationNotice.findById(saved._id)).status).toBe('accepted'); expect(messages).toHaveLength(1);
  const decoded = messages[0].replace(/=\r?\n/g, '').replace(/=3D/g, '=');
  expect(decoded).toContain(`Message-ID: <lpc-application.${saved._id}@lets-paraconnect.com>`); expect(decoded).toContain('Review application');
  expect(decoded).toContain(`caseId=${saved.caseId}&amp;tab=applications&amp;applicantId=${saved.paralegalId}`); expect(decoded).not.toContain('PRIVATE_APPLICATION_TEXT');
  await launch(); expect(messages).toHaveLength(1);
});
test('an application email retries a definite SMTP rejection after worker restart', async () => {
  const saved = await prepareApplicationEmail(); rejectRecipients = true; await launch();
  expect((await ApplicationNotice.findById(saved._id)).status).toBe('failed'); expect(messages).toHaveLength(0);
  rejectRecipients = false; await ApplicationNotice.updateOne({ _id: saved._id }, { $set: { nextAttemptAt: new Date(0) } }); await launch();
  expect((await ApplicationNotice.findById(saved._id)).status).toBe('accepted'); expect(messages).toHaveLength(1);
});
test('unknown application email acceptance never automatically resends after restart', async () => {
  const saved = await prepareApplicationEmail(); loseAcknowledgement = true; await launch();
  expect((await ApplicationNotice.findById(saved._id)).status).toBe('unknown'); expect(messages).toHaveLength(1);
  loseAcknowledgement = false; await launch(); expect((await ApplicationNotice.findById(saved._id)).status).toBe('unknown'); expect(messages).toHaveLength(1);
});

async function prepareApplicationWithdrawalEmail(source) {
  const saved = await prepareApplicationEmail(), at = new Date(), Application = require('../models/Application');
  await ApplicationNotice.deleteOne({ _id: saved._id });
  let record;
  if (source === 'canonical') {
    record = await Application.findByIdAndUpdate(saved.applicationId, { $set: { status: 'withdrawn', withdrawnAt: at }, $push: { statusHistory: { from: 'submitted', to: 'withdrawn', reason: 'revoked_by_paralegal', actorId: saved.paralegalId, at } } }, { returnDocument: 'after' }).lean();
  } else {
    await Application.deleteOne({ _id: saved.applicationId });
    record = { paralegalId: saved.paralegalId, status: 'withdrawn', note: 'PRIVATE_WITHDRAWN_LETTER', withdrawnAt: at, withdrawalRevision: 'b'.repeat(64), statusHistory: [{ from: 'pending', to: 'withdrawn', reason: 'revoked_by_paralegal', actorId: saved.paralegalId, at }] };
    await Case.collection.updateOne({ _id: saved.caseId }, { $set: { applicants: [record] } });
  }
  return ApplicationNotice.create({ kind: 'withdrawn', source, applicationId: source === 'canonical' ? saved.applicationId : null,
    submissionKey: require('../services/matterApplicationNotifications').withdrawalKey(record, source, saved.caseId),
    jobId: saved.jobId, caseId: saved.caseId, userId: saved.userId, paralegalId: saved.paralegalId });
}
for (const source of ['canonical', 'earlier']) {
  test(`a fresh worker delivers the ${source} application withdrawal once through local SMTP`, async () => {
    const saved = await prepareApplicationWithdrawalEmail(source); await launch();
    expect((await ApplicationNotice.findById(saved._id)).status).toBe('accepted'); expect(messages).toHaveLength(1);
    const decoded = messages[0].replace(/=\r?\n/g, '').replace(/=3D/g, '=');
    expect(decoded).toContain(`Message-ID: <lpc-application.${saved._id}@lets-paraconnect.com>`); expect(decoded).toContain('Application withdrawn'); expect(decoded).toContain('View application');
    expect(decoded).toContain(`caseId=${saved.caseId}&amp;applicantId=${saved.paralegalId}&amp;openApplicant=1&amp;applicationHistory=1#cases:inquiries`); expect(decoded).not.toContain('PRIVATE_');
    await launch(); expect(messages).toHaveLength(1);
  });
  test(`a ${source} application withdrawal retries a definite SMTP rejection after restart`, async () => {
    const saved = await prepareApplicationWithdrawalEmail(source); rejectRecipients = true; await launch(); expect((await ApplicationNotice.findById(saved._id)).status).toBe('failed'); expect(messages).toHaveLength(0);
    rejectRecipients = false; await ApplicationNotice.updateOne({ _id: saved._id }, { $set: { nextAttemptAt: new Date(0) } }); await launch(); expect((await ApplicationNotice.findById(saved._id)).status).toBe('accepted'); expect(messages).toHaveLength(1);
  });
  test(`unknown ${source} application withdrawal acceptance never resends automatically`, async () => {
    const saved = await prepareApplicationWithdrawalEmail(source); loseAcknowledgement = true; await launch(); expect((await ApplicationNotice.findById(saved._id)).status).toBe('unknown'); expect(messages).toHaveLength(1);
    loseAcknowledgement = false; await launch(); expect((await ApplicationNotice.findById(saved._id)).status).toBe('unknown'); expect(messages).toHaveLength(1);
  });
}
