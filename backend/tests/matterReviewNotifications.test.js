const mongoose = require("mongoose");
const { connect, clearDatabase, closeDatabase } = require("./helpers/db");
jest.mock("../utils/email", () => jest.fn(async to => ({ accepted: [to] })));
const sendEmail = require("../utils/email"), Notice = require("../models/MatterReviewNotification");
const User = require("../models/User"), Case = require("../models/Case");
const { processNotices } = require("../services/matterReviewNotifications");
let attorney, para, admin, matter, openedAt, disputeId;
beforeAll(connect); afterAll(closeDatabase); afterEach(() => jest.restoreAllMocks());
beforeEach(async () => {
 await clearDatabase(); sendEmail.mockClear();
 [attorney, para, admin] = await User.create(["attorney", "paralegal", "admin"].map(role => ({ firstName: "Synthetic", lastName: role, email: `${role}@review.test`, password: "Synthetic123!", role, status: "approved" })));
 openedAt = new Date(); disputeId = new mongoose.Types.ObjectId().toString();
 matter = await Case.create({ title: "River Street lease review", details: "Synthetic", attorney: attorney._id, attorneyId: attorney._id, paralegal: para._id, paralegalId: para._id, status: "disputed", pausedReason: "dispute", disputes: [{ disputeId, raisedBy: para._id, status: "open", message: "PRIVATE_REVIEW_MESSAGE", createdAt: openedAt }] });
});
const queue = (user = para) => Notice.create({ caseId: matter._id, userId: user._id, userRole: user.role, disputeId, openedAt });
test.each(["attorney", "paralegal", "admin", "withdrawn"])("%s email uses current title and one protected destination without private discussion", async role => {
 const user = role === "admin" ? admin : role === "attorney" ? attorney : para; const notice = await queue(user);
 if (role === "withdrawn") await Case.updateOne({ _id: matter._id }, { $unset: { paralegal: "", paralegalId: "" }, $set: { withdrawnParalegalId: para._id, paralegalAccessRevokedAt: new Date() } });
 await User.updateOne({ _id: user._id }, { $set: { email: "updated@review.test" } });
 await Case.updateOne({ _id: matter._id }, { $set: { title: "Current <b>Matter</b> title" } });
 await processNotices(); expect((await Notice.findById(notice._id)).status).toBe("accepted");
 const [to, subject, html, options] = sendEmail.mock.calls[0]; expect(to).toBe("updated@review.test"); expect(subject).toContain("Current"); expect(html).toContain("Current &lt;b&gt;Matter&lt;/b&gt; title"); expect(html).not.toContain("PRIVATE_REVIEW_MESSAGE"); expect(html.match(/<a /g)).toHaveLength(1);
 expect(html).toContain(role === "withdrawn" ? `/dashboard-paralegal.html?highlightCase=${matter._id}#cases-completed` : role === "admin" ? `/admin-dashboard.html?review=${disputeId}&amp;reviewMatter=${matter._id}#finance` : `/case-detail.html?caseId=${matter._id}&amp;tab=financials`);
 expect(options.messageId).toBe(`<lpc-review.${notice._id}@lets-paraconnect.com>`);
});
test.each(["resolved", "replaced_review", "duplicate_review", "purged", "reassigned", "contradictory_owner", "disabled", "suspended", "deleted", "unapproved", "role_changed", "email_disabled"])("%s suppresses stale or inaccessible review email", async state => {
 const notice = await queue();
 const changes = { resolved: { "disputes.0.status": "resolved" }, replaced_review: { "disputes.0.createdAt": new Date(openedAt.getTime() + 1) }, purged: { purgedAt: new Date() }, reassigned: { paralegal: new mongoose.Types.ObjectId(), paralegalId: null }, contradictory_owner: { attorneyId: new mongoose.Types.ObjectId() } };
 if (changes[state]) await Case.collection.updateOne({ _id: matter._id }, { $set: changes[state] });
 if (state === "duplicate_review") await Case.collection.updateOne({ _id: matter._id }, { $push: { disputes: (await Case.collection.findOne({ _id: matter._id })).disputes[0] } });
 const userChanges = { disabled: { disabled: true }, suspended: { suspended: true }, deleted: { deleted: true }, unapproved: { status: "pending" }, role_changed: { role: "attorney" }, email_disabled: { "notificationPrefs.email": false }, emailCase_disabled: { "notificationPrefs.emailCase": false } };
 if (userChanges[state]) await User.collection.updateOne({ _id: para._id }, { $set: userChanges[state] });
 await processNotices(); expect(sendEmail).not.toHaveBeenCalled(); expect((await Notice.findById(notice._id)).status).toBe("skipped");
});
test("administrator review email remains mandatory, but account removal prevents it", async () => {
 await User.updateOne({ _id: admin._id }, { $set: { "notificationPrefs.email": false, "notificationPrefs.emailCase": false } });
 const first = await queue(admin); await processNotices(); expect((await Notice.findById(first._id)).status).toBe("accepted");
 await Notice.deleteMany({}); const second = await queue(admin); await User.deleteOne({ _id: admin._id }); sendEmail.mockClear(); await processNotices(); expect(sendEmail).not.toHaveBeenCalled(); expect((await Notice.findById(second._id)).status).toBe("skipped");
});
