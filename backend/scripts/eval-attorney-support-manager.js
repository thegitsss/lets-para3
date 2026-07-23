const path = require("path");

require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const OpenAIImport = require("openai");
const OpenAI = OpenAIImport.default || OpenAIImport;
const { AI_MODELS } = require("../ai/config");
const { buildAttorneyEvidencePlan } = require("../ai/attorneyConversationPolicy");
const {
  buildManagerInstructions,
  selectManagerToolsForEvidencePlan,
} = require("../ai/supportManagerAgent");
const { getSupportManagerToolDefinitions } = require("../ai/supportAgentTools");
const {
  ATTORNEY_EVAL_CORPUS_VERSION,
  DEFAULT_ROUTING_REPETITIONS,
  PACKAGE_7_SUITE_VERSION,
  assertSanitizedLiveEvalPayload,
  buildRoutingMetrics,
  classifyLiveEvalFailure,
  exactToolRoutingResult,
  selectPackage7RoutingCases,
} = require("../ai/attorneySupportLiveEval");

function numberFlag(name, fallback, { min = 1, max = 20 } = {}) {
  const prefix = `--${name}=`;
  const argument = process.argv.find((value) => value.startsWith(prefix));
  const parsed = Number(argument ? argument.slice(prefix.length) : fallback);
  return Math.max(min, Math.min(max, Number.isFinite(parsed) ? Math.floor(parsed) : fallback));
}

function stringFlag(name) {
  const prefix = `--${name}=`;
  const argument = process.argv.find((value) => value.startsWith(prefix));
  return argument ? String(argument.slice(prefix.length)).trim() : "";
}

function buildExternalRoutingRequest(testCase, { instructions, tools } = {}) {
  const evidencePlan = buildAttorneyEvidencePlan({
    messageText: testCase.prompt,
    conversationHistory: testCase.history,
    conversationState: testCase.conversationState,
  });
  const plannedTools = selectManagerToolsForEvidencePlan(tools, evidencePlan);
  return {
    model: AI_MODELS.support,
    instructions,
    input: [
      ...(testCase.history || []),
      {
        role: "user",
        content: JSON.stringify({
          evaluationDataClassification: "synthetic_package_7",
          userRole: "attorney",
          pageContext: { pathname: "/dashboard-attorney.html", viewName: "dashboard-attorney" },
          conversationState: testCase.conversationState || {},
          evidencePlan,
          latestUserMessage: testCase.prompt,
        }),
      },
    ],
    tools: plannedTools,
    tool_choice: "auto",
    parallel_tool_calls: true,
    reasoning: { effort: "low" },
    max_output_tokens: 700,
    store: false,
    metadata: {
      feature: "lpc_attorney_support_package7_routing",
      case: testCase.id.slice(0, 64),
    },
  };
}

function selectCases() {
  let cases = selectPackage7RoutingCases();
  const caseFilter = stringFlag("case");
  if (caseFilter) {
    cases = cases.filter((testCase) =>
      testCase.id.includes(caseFilter) || testCase.capabilityId === caseFilter
    );
  }
  if (process.argv.includes("--quick")) {
    const seen = new Set();
    cases = cases.filter((testCase) => {
      if (seen.has(testCase.capabilityId)) return false;
      seen.add(testCase.capabilityId);
      return true;
    });
  }
  return cases;
}

async function runWithConcurrency(items, concurrency, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  async function consume() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => consume()));
  return results;
}

async function main() {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is required for the Package 7 attorney routing evaluation.");
  }
  const repetitions = numberFlag("repetitions", DEFAULT_ROUTING_REPETITIONS, { max: 10 });
  const concurrency = numberFlag("concurrency", 3, { max: 8 });
  const cases = selectCases();
  if (!cases.length) throw new Error("No Package 7 routing cases matched the requested filter.");

  const instructions = buildManagerInstructions("attorney");
  const tools = getSupportManagerToolDefinitions("attorney");
  const jobs = cases.flatMap((testCase) =>
    Array.from({ length: repetitions }, (_, repetitionIndex) => ({
      testCase,
      repetition: repetitionIndex + 1,
      request: buildExternalRoutingRequest(testCase, { instructions, tools }),
    }))
  );
  const sanitization = jobs.map((job) => assertSanitizedLiveEvalPayload(job.request));
  const preflight = {
    passed: sanitization.length === jobs.length,
    requestCount: jobs.length,
    totalBytes: sanitization.reduce((total, entry) => total + entry.byteLength, 0),
    dataClassification: "synthetic_only",
    store: false,
  };
  if (process.argv.includes("--dry-run")) {
    console.log(JSON.stringify({
      suiteVersion: PACKAGE_7_SUITE_VERSION,
      corpusVersion: ATTORNEY_EVAL_CORPUS_VERSION,
      model: AI_MODELS.support,
      caseCount: cases.length,
      repetitions,
      preflight,
    }, null, 2));
    return;
  }

  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const startedAt = new Date();
  const results = await runWithConcurrency(jobs, concurrency, async (job) => {
    const { testCase, repetition, request } = job;
    try {
      const response = await client.responses.create(request, { timeout: 45000 });
      const calledTools = (Array.isArray(response.output) ? response.output : [])
        .filter((item) => item?.type === "function_call")
        .map((item) => String(item.name || ""));
      const evaluation = exactToolRoutingResult(testCase, calledTools);
      const result = {
        caseId: testCase.id,
        capabilityId: testCase.capabilityId,
        capabilityStatus: testCase.capabilityStatus,
        languageKind: testCase.languageKind,
        stateKind: testCase.stateKind,
        conversationKind: testCase.conversationKind,
        failureKind: testCase.failureKind,
        repetition,
        critical: true,
        requiredTools: evaluation.required,
        calledTools: evaluation.called,
        passed: evaluation.passed,
        errors: evaluation.errors,
        responseId: String(response.id || ""),
        usage: {
          inputTokens: Number(response.usage?.input_tokens || 0),
          outputTokens: Number(response.usage?.output_tokens || 0),
          totalTokens: Number(response.usage?.total_tokens || 0),
        },
      };
      return { ...result, classification: result.passed ? "passed" : classifyLiveEvalFailure(result) };
    } catch (error) {
      const result = {
        caseId: testCase.id,
        capabilityId: testCase.capabilityId,
        capabilityStatus: testCase.capabilityStatus,
        languageKind: testCase.languageKind,
        stateKind: testCase.stateKind,
        conversationKind: testCase.conversationKind,
        failureKind: testCase.failureKind,
        repetition,
        critical: true,
        requiredTools: testCase.oracle.requiredTools,
        calledTools: [],
        passed: false,
        errors: ["live_request_failed"],
        infrastructureError: true,
        errorCode: String(error?.code || error?.status || "request_failed"),
      };
      return { ...result, classification: classifyLiveEvalFailure(result) };
    }
  });

  const metrics = buildRoutingMetrics(results);
  const criticalFailures = results.filter((result) => result.critical && !result.passed);
  const thresholdFailures = [];
  if (criticalFailures.length) thresholdFailures.push("critical_zero_failure_gate");
  if (metrics.passRate < 0.98) thresholdFailures.push("routing_overall_below_98_percent");
  if (metrics.perCapability.some((entry) => entry.passRate < 0.95)) {
    thresholdFailures.push("routing_capability_below_95_percent");
  }
  if (metrics.robustness.total && metrics.robustness.passRate < 0.95) {
    thresholdFailures.push("routing_robustness_below_95_percent");
  }
  if (metrics.multiTurn.total && metrics.multiTurn.passRate < 0.98) {
    thresholdFailures.push("routing_multiturn_below_98_percent");
  }
  if (metrics.compound.total && metrics.compound.passRate < 0.98) {
    thresholdFailures.push("routing_compound_below_98_percent");
  }
  const usage = results.reduce((total, result) => ({
    inputTokens: total.inputTokens + Number(result.usage?.inputTokens || 0),
    outputTokens: total.outputTokens + Number(result.usage?.outputTokens || 0),
    totalTokens: total.totalTokens + Number(result.usage?.totalTokens || 0),
  }), { inputTokens: 0, outputTokens: 0, totalTokens: 0 });
  const report = {
    suiteVersion: PACKAGE_7_SUITE_VERSION,
    corpusVersion: ATTORNEY_EVAL_CORPUS_VERSION,
    model: AI_MODELS.support,
    configuration: {
      reasoningEffort: "low",
      toolChoice: "auto",
      parallelToolCalls: true,
      maxOutputTokens: 700,
      store: false,
      concurrency,
    },
    startedAt: startedAt.toISOString(),
    completedAt: new Date().toISOString(),
    selectedCaseCount: cases.length,
    repetitions,
    runCount: results.length,
    preflight,
    usage,
    metrics,
    criticalFailureCount: criticalFailures.length,
    thresholdFailures,
    passed: thresholdFailures.length === 0,
    failures: results.filter((result) => !result.passed),
    ...(process.argv.includes("--json-details") ? { results } : {}),
  };
  console.log(JSON.stringify(report, null, 2));
  if (!report.passed) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error?.message || error);
  process.exitCode = 1;
});
