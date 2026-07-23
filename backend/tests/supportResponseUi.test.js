const path = require("path");
const { pathToFileURL } = require("url");
const { execFileSync } = require("child_process");

let results;

beforeAll(() => {
  const helperPath = path.resolve(
    __dirname,
    "../../frontend/assets/scripts/utils/support-response-ui.mjs"
  );
  const script = `
    import * as ui from ${JSON.stringify(pathToFileURL(helperPath).href)};
    console.log(JSON.stringify({
      managerAction: ui.getAssistantActionLimit({ provider: "openai_manager" }),
      fallbackAction: ui.getAssistantActionLimit({ provider: "openai_manager_safe_fallback" }),
      legacyAction: ui.getAssistantActionLimit({ provider: "deterministic" }),
      managerSuggestion: ui.getAssistantSuggestionLimit({ provider: "openai_manager" }),
      legacySuggestion: ui.getAssistantSuggestionLimit({ provider: "deterministic" }),
      genericEscalation: ui.isSupportedEscalationMetadata({ provider: "openai_manager", escalation: { available: true } }),
      genericNeed: ui.isSupportedEscalationMetadata({ provider: "openai_manager", needsEscalation: true }),
      supportedReason: ui.isSupportedEscalationMetadata({ provider: "openai_manager", needsEscalation: true, escalationReason: "workspace_access_needs_review" }),
      requestedHelp: ui.isSupportedEscalationMetadata({ provider: "openai_manager", escalation: { available: true }, primaryAsk: "request_human_help" }),
      requestedTicket: ui.isSupportedEscalationMetadata({ escalation: { requested: true, ticketReference: "SUP-101" } }),
      legacyAvailable: ui.isSupportedEscalationMetadata({ provider: "deterministic", escalation: { available: true } }),
    }));
  `;
  results = JSON.parse(execFileSync("node", ["--input-type=module", "-e", script], {
    cwd: path.resolve(__dirname, ".."),
    encoding: "utf8",
  }).trim());
});

describe("support response UI policy", () => {
  test("limits manager actions to one material action while preserving legacy limits", () => {
    expect(results.managerAction).toBe(1);
    expect(results.fallbackAction).toBe(1);
    expect(results.legacyAction).toBe(2);
  });

  test("limits manager suggestions to two while preserving legacy role behavior", () => {
    expect(results.managerSuggestion).toBe(2);
    expect(results.legacySuggestion).toBe(3);
  });

  test("does not render a manual-review card from a generic availability flag", () => {
    expect(results.genericEscalation).toBe(false);
    expect(results.genericNeed).toBe(false);
  });

  test("allows a manual-review card only for a supported escalation workflow", () => {
    expect(results.supportedReason).toBe(true);
    expect(results.requestedHelp).toBe(true);
  });

  test("continues to render a verified escalation that was already requested", () => {
    expect(results.requestedTicket).toBe(true);
  });

  test("does not change the existing paralegal or admin escalation contract", () => {
    expect(results.legacyAvailable).toBe(true);
  });
});
