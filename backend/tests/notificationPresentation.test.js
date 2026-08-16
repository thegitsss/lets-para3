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
      "createdAt", "id", "isRead", "message", "read", "type",
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
    expect(stale.message).toBe("This notification is no longer available.");

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
});
