const {
  buildMatterLink,
  buildObjectDeepLink,
  parseMatterDeepLink,
} = require("../services/objectDeepLinks");

const CASE_ID = "64b111111111111111111111";
const OBJECT_ID = "64b222222222222222222222";

describe("authenticated object deep links", () => {
  test("builds the fixed Matter object destinations", () => {
    expect(buildMatterLink({ caseId: CASE_ID, tab: "overview" })).toBe(
      `/case-detail.html?caseId=${CASE_ID}&tab=overview`
    );
    expect(buildObjectDeepLink({ type: "application", caseId: CASE_ID, applicantId: OBJECT_ID })).toBe(
      `/case-detail.html?caseId=${CASE_ID}&tab=applications&applicantId=${OBJECT_ID}`
    );
    expect(buildObjectDeepLink({ type: "file", caseId: CASE_ID, fileId: OBJECT_ID })).toBe(
      `/case-detail.html?caseId=${CASE_ID}&tab=files&fileId=${OBJECT_ID}`
    );
    expect(buildObjectDeepLink({ type: "message", caseId: CASE_ID, messageId: OBJECT_ID })).toBe(
      `/case-detail.html?caseId=${CASE_ID}&tab=messages&messageId=${OBJECT_ID}`
    );
    expect(buildObjectDeepLink({ type: "financials", caseId: CASE_ID })).toBe(
      `/case-detail.html?caseId=${CASE_ID}&tab=financials`
    );
    expect(buildObjectDeepLink({ type: "profile", profileId: OBJECT_ID })).toBe(
      `/profile-paralegal.html?paralegalId=${OBJECT_ID}`
    );
  });

  test("rejects unknown types, bad IDs, and unapproved Matter tabs", () => {
    expect(buildObjectDeepLink({ type: "https://evil.example", caseId: CASE_ID })).toBe("");
    expect(buildObjectDeepLink({ type: "message", caseId: "../admin", messageId: OBJECT_ID })).toBe("");
    expect(buildMatterLink({ caseId: CASE_ID, tab: "billing-provider" })).toBe("");
  });

  test("parses current links and maps only the two supported legacy anchors", () => {
    expect(parseMatterDeepLink(`/case-detail.html?caseId=${CASE_ID}&tab=messages&messageId=${OBJECT_ID}`)).toEqual({
      caseId: CASE_ID,
      tab: "messages",
      applicantId: "",
      fileId: "",
      messageId: OBJECT_ID,
    });
    expect(parseMatterDeepLink(`/case-detail.html?caseId=${CASE_ID}#case-messages`).tab).toBe("messages");
    expect(parseMatterDeepLink(`/case-detail.html?caseId=${CASE_ID}#caseFilesSection`).tab).toBe("files");
    expect(parseMatterDeepLink(`/case-detail.html?caseId=${CASE_ID}&tab=unknown`).tab).toBe("overview");
    expect(parseMatterDeepLink("https://evil.example/case-detail.html?caseId=" + CASE_ID)).toBeNull();
    expect(parseMatterDeepLink("//evil.example/case-detail.html?caseId=" + CASE_ID)).toBeNull();
  });
});
