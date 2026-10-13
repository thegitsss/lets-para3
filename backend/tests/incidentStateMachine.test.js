const {
  isTerminalState,
  getAllowedTransitions,
  canTransition,
  assertTransition,
  isRetryTransition,
  isEscalationTransition,
} = require("../services/incidents/stateMachine");

describe("Incident state machine", () => {
  test("recognizes terminal and non-terminal states", () => {
    expect(isTerminalState("resolved")).toBe(true);
    expect(isTerminalState("closed_no_repro")).toBe(true);
    expect(isTerminalState("investigating")).toBe(false);
  });

  test("base transitions are exposed for a normal state", () => {
    expect(getAllowedTransitions("reported")).toEqual(
      expect.arrayContaining([
        "intake_validated",
        "closed_duplicate",
        "needs_more_context",
        "needs_human_owner",
      ])
    );
  });

  test("blocks direct reported to classified transition", () => {
    expect(canTransition("reported", "classified")).toEqual(
      expect.objectContaining({
        allowed: false,
      })
    );
  });

  test("allows closed_no_repro to investigating only with admin reopen and new evidence", () => {
    expect(canTransition("closed_no_repro", "investigating")).toEqual(
      expect.objectContaining({
        allowed: false,
      })
    );

    expect(
      canTransition("closed_no_repro", "investigating", {
        explicitAdminReopen: true,
        hasNewEvidence: true,
      })
    ).toEqual(
      expect.objectContaining({
        allowed: true,
      })
    );
  });

  test("does not allow a verified release candidate to skip directly to production", () => {
    expect(canTransition("verified_release_candidate", "deploying_production").allowed).toBe(false);
  });

  test("does not allow awaiting founder approval to go direct to production", () => {
    expect(canTransition("awaiting_founder_approval", "deploying_production").allowed).toBe(false);
  });

  test("allows founder approval grants to return the incident to the verified release candidate queue", () => {
    expect(canTransition("awaiting_founder_approval", "verified_release_candidate").allowed).toBe(false);
    expect(
      canTransition("awaiting_founder_approval", "verified_release_candidate", {
        founderApprovalGranted: true,
      }).allowed
    ).toBe(true);
  });

  test("allows returning from preview to verified release candidate only with explicit preview-prepared context", () => {
    expect(canTransition("deploying_preview", "verified_release_candidate").allowed).toBe(false);
    expect(
      canTransition("deploying_preview", "verified_release_candidate", {
        previewPreparedOnly: true,
      }).allowed
    ).toBe(true);
  });

  test("allows production deployment to stop for human review when release safety gates fail", () => {
    expect(canTransition("deploying_production", "needs_human_owner").allowed).toBe(true);
  });

  test("requires post-deploy verification before resolving", () => {
    expect(canTransition("post_deploy_verifying", "resolved").allowed).toBe(false);
    expect(
      canTransition("post_deploy_verifying", "resolved", {
        postDeployChecksPassed: true,
      }).allowed
    ).toBe(true);
  });

  test("deploy failure can retry only for transient infra before production starts", () => {
    expect(canTransition("deploy_failed", "verified_release_candidate").allowed).toBe(false);
    expect(
      canTransition("deploy_failed", "verified_release_candidate", {
        failureMode: "transient_infra",
        productionDeployStarted: false,
      }).allowed
    ).toBe(true);
    expect(
      canTransition("deploy_failed", "verified_release_candidate", {
        failureMode: "transient_infra",
        productionDeployStarted: true,
      }).allowed
    ).toBe(false);
  });

  test("verification failure can return to patch planning only when retries remain", () => {
    expect(canTransition("verification_failed", "patch_planning").allowed).toBe(false);
    expect(
      canTransition("verification_failed", "patch_planning", {
        verificationRetriesRemaining: 1,
      }).allowed
    ).toBe(true);
  });

  test("retry and escalation helpers track expected transitions", () => {
    expect(isRetryTransition("verification_failed", "patch_planning")).toBe(true);
    expect(isRetryTransition("reported", "needs_human_owner")).toBe(false);
    expect(isEscalationTransition("verified_release_candidate", "awaiting_founder_approval")).toBe(true);
    expect(isEscalationTransition("patching", "awaiting_verification")).toBe(false);
  });

  test("assertTransition throws a typed error for invalid transitions", () => {
    expect(() => assertTransition("reported", "resolved")).toThrow(/Invalid incident state transition/i);
    expect(() => assertTransition("rollback_in_progress", "closed_rolled_back")).not.toThrow();
  });
});
