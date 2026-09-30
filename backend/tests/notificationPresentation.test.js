const {
  caseNotificationAccess,
  notificationObjectIds,
  presentNotification,
} = require("../services/notificationPresentation");

const ATTORNEY_ID = "64b111111111111111111111";
const PARALEGAL_ID = "64b222222222222222222222";
const OTHER_ID = "64b333333333333333333333";
const CASE_ID = "64b444444444444444444444";
const MESSAGE_ID = "64b555555555555555555555";
const FILE_ID = "64b666666666666666666666";

function matter(overrides = {}) {
  return {
    _id: CASE_ID,
    title: "Mediation Support",
    status: "in progress",
    attorney: ATTORNEY_ID,
    paralegal: PARALEGAL_ID,
    ...overrides,
  };
}

describe("safe actionable notification presentation", () => {
  test.each([
    ["Release was declined. A 24-hour review window is now active.", "Release declined"],
    ["Paralegal withdrew. Choose a partial payout or close without release.", "Paralegal withdrawal recorded"],
    ["Paralegal requested withdrawal. Please choose a partial payout or reject payout.", "Paralegal withdrawal recorded"],
    ["Partial payout set. Case relisted for applicants.", "Withdrawal decision recorded"],
    ["Close without release recorded. The case will be eligible to be relisted after 24 hours.", "Close without release recorded"],
    ["Payment released. Case completed and archived.", "Payment release recorded"],
    ["Case relisted and ready for new applicants.", "Matter relisted"],
    ["24-hour hold complete. $0 payout finalized.", "Withdrawal review window ended"],
    ["Admin requested edits: Please revise the tasks.", "LPC requested posting edits"],
    ["Payment requires action. Open the Matter to review funding.", "Funding needs attention"],
  ])("retained event has a compact headline without losing its message or access rules: %s", (summary, headline) => {
    const item = { _id: OTHER_ID, type: "case_update", payload: { caseId: CASE_ID, summary } };
    const value = presentNotification(item, { viewer: { id: ATTORNEY_ID, role: "attorney" }, caseDoc: matter() });
    expect(value).toMatchObject({ available: true, headline, message: summary, contextLabel: "Mediation Support" });
    expect(value.action.href).toContain(CASE_ID);
    const denied = presentNotification(item, { viewer: { id: OTHER_ID, role: "attorney" }, caseDoc: matter() });
    expect(denied.available).toBe(false); expect(denied.message).toBe(""); expect(denied.headline).toBeUndefined();
  });

  test("structured outcomes take precedence and unfamiliar retained events are not reinterpreted", () => {
    const options = { viewer: { id: ATTORNEY_ID, role: "attorney" }, caseDoc: matter() };
    const item = { _id: OTHER_ID, type: "case_update", payload: { caseId: CASE_ID, summary: "A different event occurred." } };
    expect(presentNotification(item, options).headline).toBe("A different event occurred.");
    expect(presentNotification({ ...item, payload: { ...item.payload, outcome: "withdrawal_decision_recorded" } }, options).headline).toBe("Withdrawal decision recorded");
  });
  test("completion identifies its Matter and directs only the owner to its final Financials", () => {
    const at=new Date(),caseDoc=matter({status:"completed",archived:true,paralegalAccessRevokedAt:at});
    const note={_id:OTHER_ID,type:"case_update",createdAt:at,payload:{caseId:CASE_ID,outcome:"matter_completion_recorded",summary:"Matter completed and archived."}};
    expect(presentNotification(note,{viewer:{id:ATTORNEY_ID,role:"attorney"},caseDoc})).toMatchObject({available:true,message:"Mediation Support: Matter completed and archived.",action:{label:"Review completed Matter",href:`/case-detail.html?caseId=${CASE_ID}&tab=financials`}});
    expect(presentNotification(note,{viewer:{id:OTHER_ID,role:"attorney"},caseDoc})).toMatchObject({available:false,message:"",action:{label:"",href:""}});
    expect(presentNotification({...note,type:"payout_released"},{viewer:{id:PARALEGAL_ID,role:"paralegal"},caseDoc})).toMatchObject({available:true,action:{label:"View payout",href:`/dashboard-paralegal.html?highlightCase=${CASE_ID}#cases-completed`}});
  });

  test.each([
    { outcome: "payment_action_required", summary: "Payment requires your attention." },
    { summary: "Payment requires action. Open the Matter to review funding." },
    { summary: "The payment has not completed. Open the Matter to review funding." },
  ])("current and retained funding notices open the relevant financial review: %j", payload => {
    const note = { _id: OTHER_ID, type: "case_update", payload: { caseId: CASE_ID, ...payload } };
    const owner = presentNotification(note, { viewer: { id: ATTORNEY_ID, role: "attorney" }, caseDoc: matter() });
    expect(owner.action).toEqual({ label: "Review funding", href: `/case-detail.html?caseId=${CASE_ID}&tab=financials` });
    const unrelated = presentNotification(note, { viewer: { id: OTHER_ID, role: "attorney" }, caseDoc: matter() });
    expect(unrelated.available).toBe(false); expect(unrelated.action).toEqual({ label: "", href: "" });
    const paralegal = presentNotification(note, { viewer: { id: PARALEGAL_ID, role: "paralegal" }, caseDoc: matter() });
    expect(paralegal.action?.href).not.toContain("tab=financials");
  });
  test("withdrawal notices open attorney decisions or retained paralegal history", () => {
    const at = new Date();
    const caseDoc = matter({ status: "paused", pausedReason: "paralegal_withdrew", pausedAt: at, paralegal: null, withdrawnParalegalId: PARALEGAL_ID });
    const note = { _id: OTHER_ID, type: "case_update", createdAt: at, payload: { caseId: CASE_ID, outcome: "paralegal_withdrawn", summary: "The paralegal withdrew." } };
    const owner = presentNotification(note, { viewer: { id: ATTORNEY_ID, role: "attorney" }, caseDoc });
    expect(owner.action).toEqual({ label: "Review withdrawal", href: `/case-detail.html?caseId=${CASE_ID}&tab=financials` });
    expect(owner.message).toBe("Mediation Support: Paralegal withdrawal recorded.");
    const previous = presentNotification(note, { viewer: { id: PARALEGAL_ID, role: "paralegal" }, caseDoc });
    expect(previous.action).toEqual({ label: "View Matter history", href: `/dashboard-paralegal.html?highlightCase=${CASE_ID}#cases-completed` });
    expect(previous.message).toBe("Mediation Support: Paralegal withdrawal recorded.");
    const unrelated = presentNotification(note, { viewer: { id: OTHER_ID, role: "attorney" }, caseDoc });
    expect(unrelated.available).toBe(false); expect(unrelated.action).toEqual({ label: "", href: "" });
  });
  test("withdrawal decisions name the authorized Matter and hide it when access is lost", () => {
    const at = new Date();
    const caseDoc = matter({ title: "River Street lease review", status: "paused", pausedReason: "paralegal_withdrew", pausedAt: at, paralegal: null, withdrawnParalegalId: PARALEGAL_ID });
    const note = { _id: OTHER_ID, type: "case_update", createdAt: at, payload: { caseId: CASE_ID, caseTitle: "Earlier title", outcome: "withdrawal_decision_recorded", summary: "No payout was recorded for this withdrawal." } };
    for (const [id, role] of [[ATTORNEY_ID, "attorney"], [PARALEGAL_ID, "paralegal"]]) {
      const value = presentNotification(note, { viewer: { id, role }, caseDoc });
      expect(value.message).toBe("River Street lease review: No payout was recorded for this withdrawal.");
      expect(value.action.label).toBe(role === "attorney" ? "Review withdrawal" : "View Matter history");
    }
    expect(presentNotification(note, { viewer: { id: OTHER_ID, role: "attorney" }, caseDoc })).toMatchObject({ available: false, message: "", action: { label: "", href: "" } });
  });
  test("rebuilds exact message and file actions instead of honoring stored URLs", () => {
    const message = presentNotification({
      _id: OTHER_ID,
      type: "message",
      link: "https://evil.example/steal",
      payload: {
        caseId: CASE_ID,
        messageId: MESSAGE_ID,
        messageSnippet: "The revised draft is ready.",
        clientSecret: "pi_secret_private",
        storageKey: "private/key.pdf",
      },
    }, {
      viewer: { id: ATTORNEY_ID, role: "attorney" },
      caseDoc: matter(),
    });
    expect(message.action).toEqual({
      label: "View message",
      href: `/case-detail.html?caseId=${CASE_ID}&tab=messages&messageId=${MESSAGE_ID}`,
    });
    expect(Object.keys(message).sort()).toEqual([
      "action", "actorFirstName", "actorProfileImage", "available", "context",
      "createdAt", "id", "isRead", "message", "read", "type", "headline", "contextLabel",
    ].sort());
    expect(JSON.stringify(message)).not.toMatch(/evil|clientSecret|storageKey|private\/key/i);

    const file = presentNotification({
      _id: OTHER_ID,
      type: "case_file_uploaded",
      payload: { caseId: CASE_ID, fileId: FILE_ID, fileName: "Draft.pdf" },
    }, {
      viewer: { id: PARALEGAL_ID, role: "paralegal" },
      caseDoc: matter(),
    });
    expect(file.action.href).toBe(`/case-detail.html?caseId=${CASE_ID}&tab=files&fileId=${FILE_ID}`);
  });

  test("suppresses stale, unrelated, revoked, and blocked notification targets", () => {
    const base = { _id: OTHER_ID, type: "message", payload: { caseId: CASE_ID, messageId: MESSAGE_ID } };
    const stale = presentNotification(base, {
      viewer: { id: ATTORNEY_ID, role: "attorney" },
      caseDoc: null,
    });
    expect(stale.available).toBe(false);
    expect(stale.action).toEqual({ label: "", href: "" });
    expect(stale.message).toBe("");

    expect(caseNotificationAccess(matter(), { id: OTHER_ID, role: "attorney" })).toEqual({
      allowed: false,
      relationship: "unrelated",
    });
    expect(caseNotificationAccess(
      matter({ paralegalAccessRevokedAt: new Date() }),
      { id: PARALEGAL_ID, role: "paralegal" },
      "message"
    ).allowed).toBe(false);
    expect(caseNotificationAccess(
      matter({ paralegal: null, applicants: [{ paralegalId: PARALEGAL_ID, status: "pending" }] }),
      { id: PARALEGAL_ID, role: "paralegal" },
      "application_submitted",
      new Set([ATTORNEY_ID])
    ).relationship).toBe("blocked");
  });

  test("does not turn malformed object references into a destination", () => {
    expect(notificationObjectIds({
      link: "https://evil.example/case-detail.html?caseId=" + CASE_ID,
      payload: { caseId: "not-an-id", messageId: "javascript:alert(1)" },
    })).toEqual({
      caseId: "",
      applicantId: "",
      applicationId: "",
      fileId: "",
      messageId: "",
      profileId: "",
    });
  });

  test("keeps paralegal rejection and closed-invitation notifications useful without reopening Matter access", () => {
    const rejected = presentNotification({
      _id: OTHER_ID,
      type: "application_denied",
      payload: { caseId: CASE_ID, caseTitle: "Mediation Support" },
    }, {
      viewer: { id: PARALEGAL_ID, role: "paralegal" },
      caseDoc: matter({ paralegal: OTHER_ID, applicants: [{ paralegalId: PARALEGAL_ID, status: "rejected" }] }),
    });
    expect(rejected).toMatchObject({
      available: true,
      message: "The role for Mediation Support has been filled",
      action: { label: "View applications", href: "/dashboard-paralegal.html#cases" },
    });

    const filledInvite = presentNotification({
      _id: OTHER_ID,
      type: "case_invite_response",
      payload: { caseId: CASE_ID, caseTitle: "Mediation Support", response: "filled" },
    }, {
      viewer: { id: PARALEGAL_ID, role: "paralegal" },
      caseDoc: matter({ paralegal: OTHER_ID, invites: [{ paralegalId: PARALEGAL_ID, status: "declined" }] }),
    });
    expect(filledInvite).toMatchObject({
      available: true,
      message: "The position for Mediation Support has been filled",
      action: { label: "Browse Matters", href: "/browse-jobs.html" },
    });
  });

  test("withdrawn paralegal review updates lead to history instead of a revoked workspace", () => {
    const update = presentNotification({
      _id: OTHER_ID,
      type: "case_update",
      createdAt: "2026-09-04T12:05:00.000Z",
      message: "The withdrawal review window ended. No payout was issued.",
      payload: { caseId: CASE_ID, caseTitle: "Mediation Support", summary: "The withdrawal review window ended. No payout was issued." },
    }, {
      viewer: { id: PARALEGAL_ID, role: "paralegal" },
      caseDoc: matter({
        paralegal: OTHER_ID,
        withdrawnParalegalId: PARALEGAL_ID,
        pausedAt: "2026-09-04T12:00:00.000Z",
      }),
    });
    expect(update).toMatchObject({
      available: true,
      message: "The withdrawal review window ended. No payout was issued.",
      action: {
        label: "View Matter history",
        href: `/dashboard-paralegal.html?highlightCase=${CASE_ID}#cases-completed`,
      },
    });
  });

  test("does not relabel a pre-withdrawal workspace notification as authorized history", () => {
    const staleWorkspace = presentNotification({
      _id: OTHER_ID,
      type: "case_update",
      createdAt: "2026-09-04T11:55:00.000Z",
      message: "Open Mediation Support",
      payload: { caseId: CASE_ID, caseTitle: "Mediation Support" },
    }, {
      viewer: { id: PARALEGAL_ID, role: "paralegal" },
      caseDoc: matter({
        paralegal: OTHER_ID,
        withdrawnParalegalId: PARALEGAL_ID,
        pausedAt: "2026-09-04T12:00:00.000Z",
      }),
    });
    expect(staleWorkspace).toMatchObject({
      available: false,
      message: "",
      action: { label: "", href: "" },
    });
  });
});

test.each(["attorney", "paralegal", "admin"])("review-opening notice gives the %s its protected review destination", role => {
 const caseDoc = matter({ status: "disputed", pausedReason: "dispute" });
 const viewer = { id: role === "attorney" ? ATTORNEY_ID : role === "paralegal" ? PARALEGAL_ID : OTHER_ID, role };
 const note = { _id: FILE_ID, type: "dispute_opened", payload: { caseId: CASE_ID, disputeId: MESSAGE_ID } };
 const href = role === "admin" ? `/admin-dashboard.html?review=${MESSAGE_ID}&reviewMatter=${CASE_ID}#finance` : `/case-detail.html?caseId=${CASE_ID}&tab=financials`;
 expect(presentNotification(note, { viewer, caseDoc })).toMatchObject({ available: true, action: { label: "View review status", href } });
});

for (const type of ['pre_engagement_requested', 'pre_engagement_changes_requested']) for (const canonical of [true, false]) test(`${type} opens the paralegal's ${canonical ? 'canonical' : 'earlier'} application form`, () => {
  const note = { _id: OTHER_ID, type, payload: { caseId: CASE_ID, applicantId: PARALEGAL_ID, ...(canonical ? { applicationId: FILE_ID } : {}) } };
  const caseDoc = matter({ status: 'open', paralegal: null, jobId: MESSAGE_ID, applicants: [{ paralegalId: PARALEGAL_ID, status: 'pending' }] });
  expect(presentNotification(note, { viewer: { id: PARALEGAL_ID, role: 'paralegal' }, caseDoc })).toMatchObject({ available: true, action: { label: 'View requirements', href: `/dashboard-paralegal.html?${canonical ? `applicationId=${FILE_ID}` : `jobId=${MESSAGE_ID}`}#cases` } });
  expect(presentNotification(note, { viewer: { id: OTHER_ID, role: 'paralegal' }, caseDoc }).available).toBe(false);
});


test('pre-engagement copy identifies the actor and Matter without exposing unavailable context', () => {
  const item = {_id:OTHER_ID,type:'pre_engagement_submitted',actorFirstName:'Jordan',payload:{caseId:CASE_ID}};
  const value = presentNotification(item,{viewer:{id:ATTORNEY_ID,role:'attorney'},caseDoc:matter()});
  expect(value.message).toBe('Jordan submitted a pre-engagement response for Mediation Support');
  expect(value.context.matterTitle).toBe('Mediation Support');
  const hidden = presentNotification(item,{viewer:{id:OTHER_ID,role:'attorney'},caseDoc:matter()});
  expect(hidden.message).toBe('');expect(hidden.context).toEqual({});
});


test('compact notification wording separates the event from recipient-safe context',()=>{
  const viewer={id:ATTORNEY_ID,role:'attorney'};
  const item={_id:OTHER_ID,userId:ATTORNEY_ID,type:'application_submitted',actorFirstName:'Jordan',payload:{caseId:CASE_ID}};
  expect(presentNotification(item,{viewer,caseDoc:matter()})).toMatchObject({headline:'Jordan applied',contextLabel:'Mediation Support'});
  const hidden=presentNotification(item,{viewer:{id:OTHER_ID,role:'attorney'},caseDoc:matter()});
  expect(hidden).not.toHaveProperty('headline');expect(hidden).not.toHaveProperty('contextLabel');
  expect(presentNotification({...item,type:'case_deleted',payload:{caseTitle:'Old posting'}},{viewer})).toMatchObject({headline:'LPC removed this posting',contextLabel:'Old posting'});
  expect(presentNotification({...item,type:'profile_approved',message:'Your profile was approved.',payload:{}},{viewer})).toMatchObject({headline:'Your profile was approved.',contextLabel:'Profile'});
});
