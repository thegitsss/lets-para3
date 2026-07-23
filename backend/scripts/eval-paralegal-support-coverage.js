#!/usr/bin/env node

const {
  buildParalegalEvaluationCorpus,
  buildParalegalEvaluationCoverageReport,
  buildPassingParalegalEvalResult,
  evaluateParalegalEvalResult,
  evaluateParalegalRoutingPlan,
} = require("../ai/paralegalSupportEvalCorpus");
const {
  buildParalegalEvidencePlan,
} = require("../ai/paralegalConversationPolicy");

function main() {
  const corpus = buildParalegalEvaluationCorpus();
  const report = buildParalegalEvaluationCoverageReport(corpus);
  const routingFailures = [];
  const routingDeferred = [];
  let routingEvaluatedCount = 0;
  const answerFailures = [];

  for (const testCase of corpus) {
    const plan = buildParalegalEvidencePlan({
      messageText: testCase.prompt,
      conversationHistory: testCase.history,
      conversationState: testCase.conversationState,
    });
    const routing = evaluateParalegalRoutingPlan(testCase, plan);
    if (routing.deferredTo) {
      routingDeferred.push({ id: testCase.id, deferredTo: routing.deferredTo });
    } else {
      routingEvaluatedCount += 1;
      if (!routing.passed) routingFailures.push({ id: testCase.id, errors: routing.errors });
    }

    const answer = evaluateParalegalEvalResult(
      testCase,
      buildPassingParalegalEvalResult(testCase)
    );
    if (!answer.passed || !answer.criticalPassed) {
      answerFailures.push({ id: testCase.id, errors: answer.errors });
    }
  }

  const output = {
    ...report,
    deterministicRouting: {
      passed: routingFailures.length === 0,
      passedCount: routingEvaluatedCount - routingFailures.length,
      evaluatedCount: routingEvaluatedCount,
      corpusCaseCount: corpus.length,
      deferredCount: routingDeferred.length,
      deferred: routingDeferred,
      failures: routingFailures,
    },
    deterministicAnswerOracle: {
      passed: answerFailures.length === 0,
      passedCount: corpus.length - answerFailures.length,
      totalCount: corpus.length,
      failures: answerFailures,
    },
    zeroCriticalFailures:
      report.passed &&
      routingFailures.length === 0 &&
      answerFailures.length === 0,
  };
  const printable = process.argv.includes("--full")
    ? output
    : {
        passed: output.passed,
        errors: output.errors,
        corpusVersion: output.corpusVersion,
        capabilityCount: output.capabilityCount,
        caseCount: output.caseCount,
        criticalCaseCount: output.criticalCaseCount,
        multiTurnCaseCount: output.multiTurnCaseCount,
        failureCaseCount: output.failureCaseCount,
        productionRegressionCount: output.productionRegressionCount,
        deterministicRouting: {
          passed: output.deterministicRouting.passed,
          passedCount: output.deterministicRouting.passedCount,
          evaluatedCount: output.deterministicRouting.evaluatedCount,
          deferredCount: output.deterministicRouting.deferredCount,
          failures: output.deterministicRouting.failures,
        },
        deterministicAnswerOracle: output.deterministicAnswerOracle,
        zeroCriticalFailures: output.zeroCriticalFailures,
      };
  process.stdout.write(`${JSON.stringify(printable, null, 2)}\n`);
  if (!output.zeroCriticalFailures) process.exitCode = 1;
}

main();
