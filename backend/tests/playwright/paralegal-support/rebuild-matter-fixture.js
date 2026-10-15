const {USER:sessionOwner}=require("./alignment-fixture");
const MATTER_ID="64b000000000000000000711", FILE_ID="64b000000000000000000712";
function matterFixture(overrides = {}) {
  return {
    _id: MATTER_ID,
    id: MATTER_ID,
    title: "Discovery response support",
    status: "in progress",
    practiceArea: "Civil Litigation",
    state: "New York",
    locationState: "New York",
    details: "Prepare, organize, and quality-check the verified discovery response set.",
    deadlineDate: "2026-09-12",
    hiredAt: "2026-08-29T14:00:00.000Z",
    archived: false,
    readOnly: false,
    paymentReleased: false,
    files: [{
      id: FILE_ID,
      original: "Interrogatory responses.pdf",
      size: 82000,
      uploadedAt: "2026-09-01T14:00:00.000Z",
      uploadedByRole: "paralegal",
      status: "pending_review",
      version: 2,
    }],
    matterExperience: {
      version: 1,
      header: {
        title: "Discovery response support",
        status: { code: "in_progress", label: "In progress" },
        practiceArea: "Civil Litigation",
        deadline: "2026-09-12",
        relationship: "Assigned paralegal",
        attention: null,
        primaryAction: { code: "continue_work", label: "Continue work", tab: "work" },
      },
      sections: [
        { id: "overview", label: "Overview" },
        { id: "work", label: "Work" },
        { id: "files", label: "Files" },
        { id: "messages", label: "Messages" },
        { id: "deadlines", label: "Deadlines" },
        { id: "activity", label: "Activity" },
        { id: "financials", label: "Payments" },
      ],
      overview: {
        summary: "Prepare, organize, and quality-check the verified discovery response set.",
        practiceArea: "Civil Litigation",
        jurisdiction: "New York",
        deadline: "2026-09-12",
        hiredAt: "2026-08-29T14:00:00.000Z",
        attorney: "Jordan Lee",
        paralegal: "Dana Young",
        paralegalId: sessionOwner,
        taskProgress: { completed: 1, total: 2 },
      },
      applications: null,
      work: {
        tasks: [{ title: "Draft responses", completed: true }, { title: "Prepare exhibits", completed: false }],
        readOnly: false,
        completed: 1,
        total: 2,
        withdrawal: { allowed: true, blockers: [], completedTaskCount: 1, totalTaskCount: 2, outcomeRequiresReview: true },
        dispute: { allowed: true, blockers: [] },
      },
      activity: [
        { code: "file", label: "File shared", at: "2026-09-01T14:00:00.000Z" },
        { code: "started", label: "Work started", at: "2026-08-29T14:00:00.000Z" },
      ],
      financials: {
        version: 2, ownerId: sessionOwner, caseId: MATTER_ID, role: "paralegal", revision: "b".repeat(64),
        currency: "USD", state: "estimate", status: "Estimated payout", stripeMode: "test", receiptsAreEarlier: true, receipts: [], receiptHref: null,
        amounts: [{ code: "compensation", label: "Remaining funded budget", cents: 90000 }, { code: "paralegal_fee", label: "Estimated platform fee", cents: 10800 }, { code: "net", label: "Estimated payout", cents: 79200 }],
        note: "The estimate uses the remaining funded budget. It is not a recorded payout.",
      },
    },
    ...overrides,
  };
}


module.exports={matterFixture,MATTER_ID,FILE_ID};
