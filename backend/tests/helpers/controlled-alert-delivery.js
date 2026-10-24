"use strict";
// Standalone integration: isolated temporary MongoDB, actual local SMTP capture,
// and synthetic exception records. Never reads .env or contacts a mail provider.
const net = require("net"), fs = require("fs"), crypto = require("crypto");
const { MongoMemoryReplSet } = require("mongodb-memory-server");
const mongoose = require("mongoose");
const captures = [], sockets = new Set();
let mode = "accept";
const server = net.createServer(socket => {
  sockets.add(socket); socket.on("close", () => sockets.delete(socket));
  socket.write("220 controlled.local ESMTP\r\n");
  let buffer = "", data = false, message = [];
  socket.on("data", chunk => {
    buffer += chunk.toString();
    while (buffer.includes("\r\n")) {
      const end = buffer.indexOf("\r\n"), line = buffer.slice(0, end); buffer = buffer.slice(end + 2);
      if (data) {
        if (line !== ".") { message.push(line); continue; }
        captures.push(message.join("\r\n")); message = []; data = false;
        if (mode === "lost_ack") { socket.destroy(); continue; }
        socket.write("250 2.0.0 captured\r\n"); continue;
      }
      const verb = line.split(" ")[0].toUpperCase();
      if (verb === "EHLO") socket.write("250-controlled.local\r\n250 SIZE 1048576\r\n");
      else if (verb === "DATA") { data = true; socket.write("354 End with dot\r\n"); }
      else if (verb === "RCPT" && mode === "reject") socket.write("550 5.1.1 synthetic rejection\r\n");
      else if (verb === "QUIT") socket.end("221 Goodbye\r\n");
      else socket.write("250 OK\r\n");
    }
  });
});
let replica, email;
(async () => {
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  Object.assign(process.env, { NODE_ENV: "test", SMTP_HOST: "127.0.0.1", SMTP_PORT: String(server.address().port), SMTP_SECURE: "false", EMAIL_DISABLE: "false", EMAIL_SKIP_VERIFY: "true", SMTP_FROM_EMAIL: "synthetic@capture.invalid", ADMIN_ALERT_EMAIL: "owner@capture.invalid", DATA_ENCRYPTION_KEY: crypto.randomBytes(32).toString("hex") });
  for (const key of ["SMTP_USER", "SMTP_PASS", "SMTP_DKIM_PKEY", "SMTP_DKIM_DOMAIN", "SMTP_DKIM_SELECTOR"]) delete process.env[key];
  email = require("../../utils/email");
  replica = await MongoMemoryReplSet.create({ replSet: { count: 1, ip: "127.0.0.1" } });
  await mongoose.connect(replica.getUri(), { dbName: `controlled_${crypto.randomBytes(6).toString("hex")}` });
  const Event = require("../../models/WebhookEvent"), Alert = require("../../models/AdminCommunicationAlert");
  const { reconcileAlerts, processAlerts } = require("../../services/adminAlertService");
  await Promise.all([Event.init(), Alert.init()]);
  const types = ["charge.dispute.created", "payment_intent.payment_failed", "refund.failed", "transfer.reversed", "synthetic.operational_exception"];
  await Event.create(types.map((type, index) => ({ eventId: `evt_controlled_${index}`, type, status: "processed", attentionRequired: true, attentionCategory: ["chargeback", "funding", "refund", "transfer", "processing"][index] })));
  await reconcileAlerts(); await reconcileAlerts(); await processAlerts(); await processAlerts();
  if (captures.length !== 5 || await Alert.countDocuments({ status: "accepted" }) !== 5) throw new Error("Controlled SMTP acceptance or deduplication failed");
  await Event.create({ eventId: "evt_controlled_rejected", type: "refund.failed", status: "processed", attentionRequired: true, attentionCategory: "refund" });
  await reconcileAlerts(); mode = "reject"; await processAlerts();
  const rejected = await Alert.findOne({ key: "payment:evt_controlled_rejected" }).lean();
  if (rejected.status !== "failed") throw new Error("Definite SMTP rejection was not retained");
  mode = "accept"; await Alert.updateOne({ _id: rejected._id }, { $set: { nextAttemptAt: new Date(0) } }); await processAlerts();
  if (await Alert.countDocuments({ status: "accepted" }) !== 6) throw new Error("Definite-failure retry did not recover");
  await Event.create({ eventId: "evt_controlled_unknown", type: "transfer.reversed", status: "processed", attentionRequired: true, attentionCategory: "transfer" });
  await reconcileAlerts(); mode = "lost_ack"; await processAlerts();
  const unknown = await Alert.findOne({ key: "payment:evt_controlled_unknown" }).lean(), afterUnknown = captures.length;
  mode = "accept"; await processAlerts();
  if (unknown.status !== "unknown" || captures.length !== afterUnknown) throw new Error("Unknown SMTP acceptance was automatically resent");
  const Message = require("../../models/Message"), MessageNotice = require("../../models/MatterMessageNotification");
  const Case = require("../../models/Case"), User = require("../../models/User"), Notification = require("../../models/Notification");
  const messages = require("../../services/matterMessageNotifications");
  await Promise.all([Message.init(), MessageNotice.init(), Case.init(), User.init(), Notification.init()]);
  const [attorney, paralegal] = await User.create(["attorney", "paralegal"].map(role => ({ firstName: "Synthetic", lastName: role, email: `${role}@capture.invalid`, password: "Synthetic123!", role, status: "approved" })));
  const matter = await Case.create({ title: "Synthetic review matter", details: "Synthetic only", attorney: attorney._id, paralegal: paralegal._id, status: "in progress", totalAmount: 40000, escrowIntentId: "pi_synthetic_capture", escrowStatus: "funded" });
  const message = await Message.create({ caseId: matter._id, senderId: attorney._id, senderRole: "attorney", type: "text", text: "PRIVILEGED_TEST_BODY_312", notificationIntent: { recipientId: paralegal._id, status: "pending" } });
  const beforeMessage = captures.length;
  await messages.processNotices(); await messages.processNotices();
  if (captures.length !== beforeMessage + 1 || captures.at(-1).includes("PRIVILEGED_TEST_BODY_312") || await MessageNotice.countDocuments({ status: "accepted" }) !== 1) throw new Error("Message SMTP recovery, deduplication or confidentiality failed");
  const disputeId = new mongoose.Types.ObjectId().toString(), commentId = new mongoose.Types.ObjectId();
  await Case.updateOne({ _id: matter._id }, { $set: { status: "disputed", pausedReason: "dispute" }, $push: { disputes: { disputeId, message: "Synthetic review", raisedBy: attorney._id, status: "open", comments: [{ _id: commentId, by: paralegal._id, text: "PRIVILEGED_REVIEW_COMMENT_312", createdAt: new Date() }] } } });
  await require("../../services/adminAlertService").enqueueAlert({ key: `dispute-comment:${matter._id}:${disputeId}:${commentId}`, kind: "dispute_comment", targetId: matter._id });
  const beforeComment = captures.length;
  await processAlerts(); await processAlerts();
  if (captures.length !== beforeComment + 1 || captures.at(-1).includes("PRIVILEGED_REVIEW_COMMENT_312") || await Alert.countDocuments({kind:"dispute_comment",status:"accepted"}) !== 1) throw new Error("Dispute-comment alert transport or confidentiality failed");
  const State = require("../../models/OpsMonitorState"); await State.init();
  process.env.OWNER_ALERT_EMAILS = "owner@capture.invalid";
  const operational = require("../../services/operationalNotifications");
  const beforeOperational = captures.length;
  const transition = {ok:false,fingerprint:"synthetic_ops_failure",checkedAt:new Date().toISOString()};
  await operational.persistMonitorState(transition,{noticeKind:"failure"});
  await operational.persistMonitorState(transition,{noticeKind:"failure"});
  await processAlerts(); await processAlerts();
  if(captures.length!==beforeOperational+1 || await Alert.countDocuments({kind:"operational",status:"accepted"})!==1)throw new Error("Operational alert transport or transition deduplication failed");
  const Collection = require("../../models/KnowledgeCollection"), Item = require("../../models/KnowledgeItem"), Revision = require("../../models/KnowledgeRevision"), Preference = require("../../models/AutonomyPreference"), Ticket = require("../../models/SupportTicket");
  await Promise.all([Collection.init(),Item.init(),Revision.init(),Preference.init(),Ticket.init()]);
  const collection=await Collection.create({key:"synthetic-correspondence",title:"Synthetic support",audienceScopes:["support_safe"]});
  const item=await Item.create({key:"synthetic-email-notifications",title:"Notification preferences",collectionId:collection._id,recordType:"objection_card",approvalState:"approved",audienceScopes:["support_safe"],tags:["paralegal"],nextReviewAt:new Date("2027-01-01")});
  const question="How do I change notification preferences?";
  const revision=await Revision.create({knowledgeItemId:item._id,revisionNumber:1,fingerprint:"synthetic-support",approvalState:"approved",content:{objection:question,approvedResponse:"Open Settings and select Notifications to change your message preferences."}});
  await Item.updateOne({_id:item._id},{$set:{currentApprovedRevisionId:revision._id}});await User.updateOne({_id:paralegal._id},{$set:{emailVerified:true}});
  const correspondence=await Ticket.create({subject:"Notification preferences",message:question,requesterUserId:paralegal._id,userId:paralegal._id,requesterEmail:paralegal.email,requesterRole:"paralegal",sourceSurface:"paralegal"});
  await Preference.create({agentRole:"CCO",actionType:"support_routine_reply",mode:"auto",dailyAttemptLimit:3,outboundRules:{startHour:0,endHour:24,timeZone:"UTC"}});
  const beforeCorrespondence=captures.length,automatic=require("../../services/support/automaticCorrespondence"),syntheticTime=new Date("2026-10-09T14:00:00Z");
  await automatic.processAutomaticCorrespondence({now:syntheticTime});await automatic.processAutomaticCorrespondence({now:syntheticTime});
  const correspondenceRecord=await Ticket.findById(correspondence._id).select("+automaticCorrespondence").lean();
  if(captures.length!==beforeCorrespondence+1||!captures.at(-1).includes("automated LPC assistant")||correspondenceRecord.automaticCorrespondence?.status!=="accepted")throw new Error("Automatic support transport, disclosure or deduplication failed");
  const result = { observedAt: new Date().toISOString(), productionAccess: false, channels: ["temporary MongoDB", "local SMTP capture"], categories: types, acceptedInitial: 5, deduplicated: true, definiteRejectionRetained: true, retryAccepted: true, lostAcknowledgementHeld: true, automaticUnknownResend: false, automaticSupportCapturedOnce: true, automaticSenderDisclosed: true, automaticPolicyActivatedOnlyInTemporaryDatabase: true, operationalTransitionCapturedOnce: true, operationalStateCommitted: true, disputeCommentCapturedOnce: true, disputeCommentBodyOmitted: true, messageIntentRecovered: true, messageEmailCapturedOnce: true, confidentialBodyOmitted: true, inboxOrExternalProviderVerified: false };
  fs.writeFileSync(process.argv[2], JSON.stringify(result, null, 2) + "\n", { mode: 0o600 });
  process.stdout.write(JSON.stringify(result) + "\n");
})().catch(error => { process.stderr.write(String(error.message) + "\n"); process.exitCode = 1; }).finally(async () => {
  email?.transporter?.close(); for (const socket of sockets) socket.destroy();
  await new Promise(resolve => server.close(resolve)); await mongoose.disconnect(); await replica?.stop();
});
