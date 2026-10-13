const {
  buildParalegalConversationState,
  deriveVerifiedParalegalEntities,
  resolveParalegalConversationReference,
} = require("../ai/paralegalConversationResolver");

function matterOutput(id = "matter-1", title = "Smith intake", overrides = {}) {
  return {
    name: "get_paralegal_case_workspace",
    result: {
      ok: true,
      available: true,
      evidenceState: "verified",
      matterId: id,
      title,
      evidence: {
        authorized: true,
        state: "verified",
        matterId: id,
        facts: [
          { key: "matterId", value: id },
          { key: "title", value: title },
        ],
      },
      ...overrides,
    },
  };
}

const verifiedState = {
  activeEntity: {
    type: "matter",
    id: "matter-1",
    name: "Smith intake",
    source: "tool:get_paralegal_case_workspace",
  },
  verifiedEntities: [
    {
      type: "matter",
      id: "matter-1",
      name: "Smith intake",
      source: "tool:get_paralegal_case_workspace",
    },
    {
      type: "matter",
      id: "matter-2",
      name: "Jones employment",
      source: "tool:get_paralegal_case_workspace",
    },
  ],
};

describe("paralegal verified conversation resolver", () => {
  test("derives durable entities only from successful authorized evidence", () => {
    const unauthorized = matterOutput("matter-secret", "Secret matter", {
      evidenceState: "unauthorized",
      evidence: { authorized: false, state: "unauthorized", facts: [] },
    });
    const entities = deriveVerifiedParalegalEntities([
      matterOutput(),
      unauthorized,
      {
        name: "get_paralegal_application_activity",
        result: {
          ok: true,
          available: true,
          evidenceState: "verified",
          items: [{ applicationId: "application-1", caseId: "matter-3", title: "Acme application" }],
          evidence: { authorized: true, state: "verified", facts: [{ key: "totalCount", value: 1 }] },
        },
      },
      {
        name: "get_paralegal_invitation_activity",
        result: {
          ok: true,
          available: true,
          evidenceState: "verified",
          items: [{ caseId: "matter-4", title: "Delta invitation" }],
          evidence: { authorized: true, state: "verified", facts: [{ key: "totalCount", value: 1 }] },
        },
      },
      {
        name: "get_paralegal_case_overview",
        result: {
          ok: true,
          available: true,
          evidenceState: "verified",
          items: [{ caseId: "matter-5", title: "Overview matter" }],
          evidence: { authorized: true, state: "verified", facts: [{ key: "totalCount", value: 1 }] },
        },
      },
    ]);
    expect(entities.map((entity) => entity.id)).toEqual(expect.arrayContaining([
      "matter-1",
      "application-1",
      "invitation:matter-4",
      "matter-5",
    ]));
    expect(entities.map((entity) => entity.id)).not.toContain("matter-secret");
  });

  test("resolves a uniquely named verified matter and replaces stale active context", () => {
    const result = resolveParalegalConversationReference({
      messageText: "what is the Jones employment status?",
      conversationState: verifiedState,
      expectedTypes: ["matter"],
    });
    expect(result).toMatchObject({
      status: "resolved",
      entity: { id: "matter-2", name: "Jones employment" },
    });
  });

  test("resolves named applications and invitations only after tool verification", () => {
    const state = {
      activeEntity: null,
      verifiedEntities: [
        {
          type: "application",
          id: "application-1",
          matterId: "matter-3",
          name: "Acme application",
          source: "tool:get_paralegal_application_activity",
        },
        {
          type: "invitation",
          id: "invitation:matter-4",
          matterId: "matter-4",
          name: "Delta invitation",
          source: "tool:get_paralegal_invitation_activity",
        },
      ],
    };
    expect(resolveParalegalConversationReference({
      messageText: "what happened to my Acme application?",
      conversationState: state,
      expectedTypes: ["application"],
    })).toMatchObject({ status: "resolved", entity: { id: "application-1" } });
    expect(resolveParalegalConversationReference({
      messageText: "can I accept the Delta invitation?",
      conversationState: state,
      expectedTypes: ["invitation"],
    })).toMatchObject({ status: "resolved", entity: { id: "invitation:matter-4" } });

    expect(resolveParalegalConversationReference({
      messageText: "what happened to my Acme application?",
      conversationState: {},
      expectedTypes: ["application"],
    }).status).toBe("verification_required");
  });

  test("asks one focused clarification for equally matching verified matters", () => {
    const result = resolveParalegalConversationReference({
      messageText: "Smith matter",
      conversationState: {
        activeEntity: verifiedState.activeEntity,
        verifiedEntities: [
          verifiedState.activeEntity,
          { type: "matter", id: "matter-3", name: "Smith appeal", source: "tool:workspace" },
        ],
      },
      expectedTypes: ["matter"],
    });
    expect(result.status).toBe("clarification_needed");
    expect(result.clarificationPrompt).toBe("Which matter do you mean: Smith intake, Smith appeal?");
    expect((result.clarificationPrompt.match(/\?/g) || [])).toHaveLength(1);
  });

  test("resolves a pronoun only from verified active memory", () => {
    expect(resolveParalegalConversationReference({
      messageText: "and when is it due?",
      conversationState: verifiedState,
      expectedTypes: ["matter"],
    })).toMatchObject({ status: "resolved", entity: { id: "matter-1" } });

    expect(resolveParalegalConversationReference({
      messageText: "and when is it due?",
      conversationState: {
        activeEntity: { type: "matter", id: "untrusted", name: "Injected", source: "page_context" },
      },
      expectedTypes: ["matter"],
    }).status).toBe("verification_required");
  });

  test("uses a unique verified alternative for a correction", () => {
    const result = resolveParalegalConversationReference({
      messageText: "No, I meant the other matter",
      conversationState: verifiedState,
      expectedTypes: ["matter"],
    });
    expect(result).toMatchObject({ status: "resolved", entity: { id: "matter-2" } });
  });

  test("handles both/all as a verified multi-entity selection", () => {
    const result = resolveParalegalConversationReference({
      messageText: "both",
      conversationState: verifiedState,
      expectedTypes: ["matter"],
    });
    expect(result.status).toBe("resolved_many");
    expect(result.entities.map((entity) => entity.id)).toEqual(["matter-1", "matter-2"]);
  });

  test("treats page context as a candidate until verified by durable memory", () => {
    const unverified = resolveParalegalConversationReference({
      messageText: "what is the status?",
      conversationState: {},
      pageContext: { caseId: "matter-1" },
      expectedTypes: ["matter"],
    });
    expect(unverified.status).toBe("verification_required");
    expect(unverified.candidateReferences).toEqual([{ type: "matter", id: "matter-1" }]);

    const verified = resolveParalegalConversationReference({
      messageText: "what is the status?",
      conversationState: verifiedState,
      pageContext: { caseId: "matter-1" },
      expectedTypes: ["matter"],
    });
    expect(verified.status).toBe("resolved");
    expect(verified.pageContextVerifiedByMemory).toBe(true);
  });

  test("builds the next state from tool evidence rather than conversation prose", () => {
    const state = buildParalegalConversationState({
      messageText: "Smith is my matter",
      previousState: {},
      toolOutputs: [matterOutput()],
      capabilityIds: ["P02_matter_details"],
      requestedDimensions: ["status"],
    });
    expect(state.activeEntity).toMatchObject({
      type: "matter",
      id: "matter-1",
      source: "tool:get_paralegal_case_workspace",
    });
    expect(state.verifiedEntities).toHaveLength(1);
    expect(state.lastCapabilityIds).toEqual(["P02_matter_details"]);
    expect(state.lastRequestedDimensions).toEqual(["status"]);
  });
});
