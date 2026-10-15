const assert = require("node:assert/strict");
const guard = require("../ai/supportCostBudget");
const API_KEY = "synthetic-ceiling-unit-key";
const env = { NODE_ENV: "staging", LPC_DEPLOYMENT_ENV: "staging", RENDER_SERVICE_ID: "srv-d10gdh24d50c73ap2p60", RENDER_GIT_COMMIT: "a".repeat(40) };
const CAP = 10000000000, RESERVE = 4642400000;
function authority(extra = {}) {
  return { approved: true, syntheticOnly: true, productionAuthorized: false, scope: "lpc37-assistant-synthetic-provider-acceptance", serviceId: env.RENDER_SERVICE_ID, candidateCommit: env.RENDER_GIT_COMMIT, model: guard.MODEL, modelAccessConfirmed: true, modelAccessEvidenceSha256: "1".repeat(64), providerKeySha256: guard.sha(API_KEY), projectId: "proj_synthetic", standardGlobalTierConfirmed: true, pricingEvidenceSha256: guard.CEILING_BILLING.pricingEvidenceSha256, billingMode: "full_model_ceiling", ceilingBilling: { ...guard.CEILING_BILLING, confirmed: true }, ownerDecisionSha256: "4".repeat(64), packetId: "lpc-assistant-11111111-1111-4111-8111-111111111111", capNanoUsd: CAP, maxGenerationAttempts: 20, maxCountAttempts: 20, validFromUtc: new Date(Date.now() - 1000).toISOString(), validUntilUtc: new Date(Date.now() + 60000).toISOString(), databaseName: "lpc_staging_shared_20261012", journalCollection: guard.COLLECTION, executionMode: "hosted", allowedFeatures: Object.keys(guard.FEATURES), syntheticSafetyIdentifiers: ["synthetic-subject"], allowedPromptSha256: [guard.sha("Hello synthetic observer")], ...extra };
}
function request(extra = {}) {
  return { method: "POST", headers: { Authorization: "Bearer " + API_KEY, "Content-Type": "application/json", "OpenAI-Project": "proj_synthetic" }, body: JSON.stringify({ model: guard.MODEL, instructions: "Only synthetic facts.", input: [{ role: "user", content: JSON.stringify({ userRole: "attorney", latestUserMessage: "Hello synthetic observer" }) }], reasoning: { effort: "low" }, max_output_tokens: 1800, store: false, safety_identifier: "synthetic-subject", metadata: { feature: "lpc_support_manager", role: "attorney" }, ...extra }) };
}
function memoryJournal(cap = CAP) {
  const records = []; let remaining = cap, halted = false;
  return { records, get remaining() { return remaining; }, get halted() { return halted; },
    async reserve(kind, amount, requestSha256) { assert(!halted && remaining >= amount, "budget exhausted"); remaining -= amount; const r = { kind, reservedNanoUsd: amount, requestSha256, state: "reserved" }; records.push(r); return r; },
    async observe(r, details, upperBound = null) { assert.equal(r.state, "reserved"); r.state = upperBound === null ? "unknown_hold_retained" : "known"; r.details = details; r.actualNanoUsd = upperBound; if (upperBound !== null) remaining += r.reservedNanoUsd - upperBound; },
    async halt() { halted = true; },
  };
}
const result = (extra = {}) => ({ id: "resp_synthetic", object: "response", model: guard.MODEL, service_tier: "default", output: [], usage: { input_tokens: 1000, output_tokens: 100 }, ...extra });
const response = (extra = {}) => new Response(JSON.stringify(result(extra)), { status: 200, headers: { "content-type": "application/json", "x-request-id": "synthetic-ceiling" } });
const call = (fetch, init = request()) => fetch("https://api.openai.com/v1/responses", init);
const create = (journal, transport, a = authority()) => guard.createGuardedFetch({ authority: a, env, journal, transport });

test("official full-model long-cache-write/output ceiling is pinned and finite for original1800 cap", () => {
  assert.equal(guard.CEILING_BILLING.inputCeilingTokens, 922000);
  assert.equal(guard.CEILING_BILLING.modelOutputCeilingTokens, 128000);
  assert.equal(guard.CEILING_BILLING.inputNanoUsdPerToken, 5000);
  assert.equal(guard.CEILING_BILLING.outputNanoUsdPerToken, 18000);
  assert.equal(922000 * 5000 + 1800 * 18000, RESERVE);
  assert.equal(RESERVE / 1e9, 4.6424);
  assert(2 * RESERVE <= CAP && 3 * RESERVE > CAP);
});
test("only explicit ceiling opt-in with exact actual evidence and model bounds bypasses unknown counter billing", () => {
  guard.validateAuthority(authority(), env);
  for (const change of [{ billingMode: undefined }, { billingMode: "exact_counter" }, { billingMode: "automatic" }, { ceilingBilling: undefined }, { pricingEvidenceSha256: "2".repeat(64) }, ...["confirmed", "model", "serviceTier", "inputCeilingTokens", "modelOutputCeilingTokens", "inputNanoUsdPerToken", "outputNanoUsdPerToken", "modelEvidenceSha256", "pricingEvidenceSha256"].map(key => ({ ceilingBilling: { ...guard.CEILING_BILLING, confirmed: true, [key]: "changed" } }))]) assert.throws(() => guard.validateAuthority(authority(change), env));
});
test("ceiling generation has zero counter HTTP, reserves first, explicitly normalizes default tier and hashes actual immutable wire", async () => {
  const journal = memoryJournal(), init = request(), original = init.body, sent = [];
  init.headers["Content-Length"] = String(Buffer.byteLength(original));
  const fetch = create(journal, async (url, options) => {
    assert.equal(url, "https://api.openai.com/v1/responses"); assert.equal(journal.records.length, 1); assert.equal(journal.remaining, CAP - RESERVE);
    assert.equal(journal.records[0].kind, "generation"); assert.equal(journal.records[0].state, "reserved"); assert.equal(journal.records[0].requestSha256, guard.sha(options.body));
    const headers = new Headers(options.headers); assert(!headers.has("content-length")); assert.equal(headers.get("authorization"), "Bearer " + API_KEY); assert.equal(headers.get("openai-project"), "proj_synthetic");
    assert.equal(options.redirect, "error"); sent.push(options.body); return response();
  });
  assert.equal((await call(fetch, init)).status, 200); assert.equal(init.body, original); assert.equal(JSON.parse(sent[0]).service_tier, "default");
  assert.deepEqual(JSON.parse(sent[0]), { ...JSON.parse(original), service_tier: "default" });
  assert.equal(journal.records[0].details.costBasis, "conservative_upper_bound"); assert.equal(journal.records[0].details.actualBillingKnown, false);
  assert.equal(journal.records[0].details.conservativeUpperBoundNanoUsd, 6800000); assert.equal(journal.remaining, CAP - 6800000);
});
test("already explicit default tier preserves original wire and length header; every existing feature output cap remains unchanged", async () => {
  for (const [feature, [role, max]] of Object.entries(guard.FEATURES)) {
    const init = request({ service_tier: "default", metadata: { feature, role }, max_output_tokens: max, input: [{ role: "user", content: JSON.stringify({ userRole: role, latestUserMessage: "Hello synthetic observer" }) }] }), original = init.body;
    init.headers["Content-Length"] = String(Buffer.byteLength(original)); const journal = memoryJournal();
    await call(create(journal, async (url, options) => { assert.equal(options.body, original); assert.equal(new Headers(options.headers).get("content-length"), init.headers["Content-Length"]); return response(); }), init);
    assert.equal(journal.records[0].reservedNanoUsd, 922000 * 5000 + max * 18000); assert.equal(init.body, original);
  }
});
test("long inputs and missing cache breakdown settle only the conservative total-input upper bound", () => {
  const base = { input_tokens: 300000, output_tokens: 100, total_tokens: 300100 };
  const expected = 300000 * 5000 + 100 * 18000;
  for (const details of [undefined, {}, { cached_tokens: 299999 }, { cache_write_tokens: 300000 }, { cached_tokens: 200000, cache_write_tokens: 100000 }]) assert.equal(guard.ceilingUsageUpperBound(result({ usage: { ...base, input_tokens_details: details } }), 1800), expected);
  assert.equal(guard.ceilingUsageUpperBound(result({ usage: { input_tokens: 922000, output_tokens: 1800 } }), 1800), RESERVE);
});
test("missing usage holds full reserve and a fresh guard cannot refund an earlier uncertain attempt", async () => {
  for (const usage of [undefined, null, {}, { input_tokens: 1000 }, { output_tokens: 100 }]) {
    const journal = memoryJournal(); await call(create(journal, async () => response({ usage })));
    assert.equal(journal.remaining, CAP - RESERVE); assert.equal(journal.records[0].state, "unknown_hold_retained"); assert.equal(journal.records[0].details.conservativeUpperBoundNanoUsd, null);
    await call(create(journal, async () => response())); assert.equal(journal.remaining, CAP - RESERVE - 6800000); assert.equal(journal.records[0].state, "unknown_hold_retained");
  }
});
test("timeout, failed HTTP and malformed successful JSON retain full physical-attempt reservation", async () => {
  for (const transport of [async () => { throw Error("synthetic-uncertain"); }, async () => new Response("synthetic-unavailable", { status: 503 }), async () => new Response("not-json", { status: 200 })]) {
    const journal = memoryJournal(); try { await call(create(journal, transport)); } catch (error) { assert.match(error.message, /synthetic-uncertain|reconciliation/); }
    assert.equal(journal.remaining, CAP - RESERVE); assert.equal(journal.records.length, 1); assert(["reserved", "unknown_hold_retained"].includes(journal.records[0].state));
  }
});
test("model, tier or contradictory usage mismatch halts future sends and retains this full reserve", async () => {
  const invalid = [{ model: "other" }, { service_tier: "priority" }, { service_tier: undefined }, { usage: { input_tokens: 922001, output_tokens: 0 } }, { usage: { input_tokens: 1000, output_tokens: 1801 } }, { usage: { input_tokens: "1000", output_tokens: 0 } }, { usage: { input_tokens: -1, output_tokens: 0 } }, { usage: { input_tokens: 1, output_tokens: 0, total_tokens: 2 } }, ...[null, [], { cached_tokens: -1 }, { cached_tokens: 2 }, { cached_tokens: 1, cache_write_tokens: 1 }].map(input_tokens_details => ({ usage: { input_tokens: 1, output_tokens: 0, input_tokens_details } }))];
  for (const extra of invalid) {
    let sends = 0; const journal = memoryJournal(), fetch = create(journal, async () => { sends++; return response(extra); });
    await assert.rejects(call(fetch), /reconciliation/); assert(journal.halted); await assert.rejects(call(fetch), /incident/); assert.equal(sends, 1); assert.equal(journal.remaining, CAP - RESERVE);
  }
});
test("parallel uncertain calls share full reservations and deny every physical send beyond the10USD envelope", async () => {
  const journal = memoryJournal(); let sends = 0;
  const fetch = create(journal, async () => { sends++; return response({ usage: undefined }); });
  const outcomes = await Promise.allSettled(Array.from({ length: 20 }, () => call(fetch)));
  assert.equal(outcomes.filter(r => r.status === "fulfilled").length, 2); assert.equal(sends, 2); assert.equal(journal.records.length, 2); assert.equal(journal.remaining, CAP - 2 * RESERVE); assert(journal.remaining >= 0);
});
test("actual installed SDK keeps original2retry policy but third attempt is refused before physical send after two unknown503 holds", async () => {
  const OpenAI = require("openai"), journal = memoryJournal(); const retryHeaders = [];
  const fetch = create(journal, async (url, options) => { assert.equal(url, "https://api.openai.com/v1/responses"); retryHeaders.push(new Headers(options.headers).get("x-stainless-retry-count")); return new Response(JSON.stringify({ error: { message: "synthetic503", type: "server_error" } }), { status: 503, headers: { "content-type": "application/json", "retry-after-ms": "1" } }); });
  const client = new OpenAI({ apiKey: API_KEY, project: "proj_synthetic", fetch, maxRetries: 2 });
  await assert.rejects(client.responses.create(JSON.parse(request().body))); assert.deepEqual(retryHeaders, ["0", "1"]); assert.equal(journal.records.length, 2); assert.equal(journal.remaining, CAP - 2 * RESERVE);
});
test("caller mutation while reserve awaits cannot change normalized request bytes, headers, endpoint or journal hash", async () => {
  const journal = memoryJournal(), reserve = journal.reserve.bind(journal), init = request(), original = init.body; let release, ready;
  const reached = new Promise(resolve => { ready = resolve; }), barrier = new Promise(resolve => { release = resolve; });
  journal.reserve = async (...args) => { const record = await reserve(...args); ready(); await barrier; return record; };
  const fetch = create(journal, async (url, options) => { assert.equal(url, "https://api.openai.com/v1/responses"); assert.equal(options.method, "POST"); assert.equal(new Headers(options.headers).get("authorization"), "Bearer " + API_KEY); assert.deepEqual(JSON.parse(options.body), { ...JSON.parse(original), service_tier: "default" }); assert.equal(journal.records[0].requestSha256, guard.sha(options.body)); return response(); });
  const url = new URL("https://api.openai.com/v1/responses"), pending = fetch(url, init); await reached;
  init.body = "unapproved"; init.method = "DELETE"; init.headers.Authorization = "Bearer changed"; url.hostname = "elsewhere.invalid";
  release(); await pending;
});
test("changed authority or cancellation after reservation causes zero sends with full reserve retained", async () => {
  for (const cancel of [false, true]) {
    const journal = memoryJournal(), reserve = journal.reserve.bind(journal), a = authority(), controller = new AbortController(); let sends = 0;
    journal.reserve = async (...args) => { const r = await reserve(...args); if (cancel) controller.abort(Error("owned-abort")); else a.ownerDecisionSha256 = "5".repeat(64); return r; };
    await assert.rejects(call(create(journal, async () => { sends++; }, a), { ...request(), signal: controller.signal }), /authority changed|owned-abort/);
    assert.equal(sends, 0); assert.equal(journal.remaining, CAP - RESERVE);
  }
});
test("original privacy, role, prompt, key, project, source and default-tier boundaries remain active in ceiling mode", async () => {
  let sends = 0; const fetch = create(memoryJournal(), async () => { sends++; });
  for (const init of [request({ model: "other" }), request({ max_output_tokens: 1801 }), request({ service_tier: "flex" }), request({ safety_identifier: "other-subject" }), request({ metadata: { feature: "lpc_support_manager", role: "paralegal" } }), request({ tools: [{ type: "web_search" }] }), request({ input: [{ role: "user", content: "Confidential non-approved prompt" }] }), { ...request(), headers: { Authorization: "Bearer other" } }, { ...request(), headers: { Authorization: "Bearer " + API_KEY, "OpenAI-Project": "proj_other" } }]) await assert.rejects(call(fetch, init));
  assert.equal(sends, 0); assert.throws(() => guard.validateAuthority(authority(), { ...env, NODE_ENV: "production" }));
});
test("a previously exact-counter guard cannot switch modes to bypass its counter-billing confirmation", async () => {
  const a = authority({ billingMode: "exact_counter", counterBilling: { confirmed: true, flatNanoUsdPerAttempt: 0, evidenceSha256: "3".repeat(64) } });
  let sends = 0; const fetch = create(memoryJournal(), async () => { sends++; }, a);
  a.billingMode = "full_model_ceiling"; a.counterBilling.confirmed = false;
  await assert.rejects(call(fetch), /billing mode changed/); assert.equal(sends, 0);
});
