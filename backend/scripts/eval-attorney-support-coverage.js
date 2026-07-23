const path = require("path");

require("dotenv").config({ path: path.join(__dirname, "..", ".env") });
process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || "sk_test_attorney_support_coverage";

const {
  getAttorneySupportCapabilities,
} = require("../ai/attorneySupportCapabilities");
const {
  buildAttorneyEvaluationCorpus,
  buildAttorneyEvaluationCoverageReport,
  buildPassingAttorneyEvalResult,
  evaluateAttorneyEvalResult,
  evaluateAttorneyRoutingPlan,
} = require("../ai/attorneySupportEvalCorpus");
const { buildAttorneyEvidencePlan } = require("../ai/attorneyConversationPolicy");
const { getSupportManagerToolDefinitions } = require("../ai/supportAgentTools");

function main() {
  const capabilities = getAttorneySupportCapabilities();
  const toolNames = new Set(getSupportManagerToolDefinitions("attorney").map((tool) => tool.name));
  const missingTools = capabilities.flatMap((capability) =>
    capability.tools
      .filter((tool) => !toolNames.has(tool))
      .map((tool) => ({ capabilityId: capability.id, tool }))
  );
  const evalCases = buildAttorneyEvaluationCorpus();
  const coverage = buildAttorneyEvaluationCoverageReport(evalCases);
  const routingFailures = evalCases.flatMap((testCase) => {
    if (testCase.planningMode === "semantic_capability") return [];
    const plan = buildAttorneyEvidencePlan({
      messageText: testCase.prompt,
      conversationHistory: testCase.history,
      conversationState: testCase.conversationState,
    });
    const evaluation = evaluateAttorneyRoutingPlan(testCase, plan);
    return evaluation.passed ? [] : [{ id: testCase.id, errors: evaluation.errors }];
  });
  const answerFailures = evalCases.flatMap((testCase) => {
    const evaluation = evaluateAttorneyEvalResult(testCase, buildPassingAttorneyEvalResult(testCase));
    return evaluation.passed ? [] : [{ id: testCase.id, errors: evaluation.errors }];
  });
  const criticalCases = evalCases.filter((testCase) => testCase.oracle.critical);
  const criticalFailures = criticalCases.filter((testCase) =>
    !evaluateAttorneyEvalResult(testCase, buildPassingAttorneyEvalResult(testCase)).passed
  );
  const report = {
    role: "attorney",
    corpusVersion: coverage.corpusVersion,
    passed:
      missingTools.length === 0 &&
      coverage.passed &&
      routingFailures.length === 0 &&
      answerFailures.length === 0 &&
      criticalFailures.length === 0,
    capabilityCount: capabilities.length,
    readyCapabilityCount: coverage.readyCapabilityCount,
    authorizedToolCount: toolNames.size,
    generatedEvalCaseCount: coverage.caseCount,
    multiTurnEvalCaseCount: coverage.multiTurnCaseCount,
    failureEvalCaseCount: coverage.failureCaseCount,
    criticalEvalCaseCount: criticalCases.length,
    criticalPassRate: criticalCases.length
      ? Number(((criticalCases.length - criticalFailures.length) / criticalCases.length).toFixed(4))
      : 1,
    productionRegressionCount: coverage.productionRegressionCount,
    missingTools,
    corpusErrors: coverage.errors,
    routingFailures,
    answerFailures,
    criticalFailures: criticalFailures.map((testCase) => testCase.id),
    capabilityCoverage: coverage.capabilityCoverage,
  };
  console.log(JSON.stringify(report, null, 2));
  if (!report.passed) process.exitCode = 1;
}

main();
