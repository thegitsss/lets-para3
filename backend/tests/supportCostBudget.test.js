const assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), os = require("node:os");
const guard = require("../ai/supportCostBudget");
const API_KEY = "synthetic-cost-unit-key";
const env = { NODE_ENV: "staging", LPC_DEPLOYMENT_ENV: "staging", RENDER_SERVICE_ID: "srv-d10gdh24d50c73ap2p60", RENDER_GIT_COMMIT: "a".repeat(40) };
function authority(extra = {}) {
  return { approved: true, syntheticOnly: true, productionAuthorized: false, scope: "lpc37-assistant-synthetic-provider-acceptance", serviceId: env.RENDER_SERVICE_ID, candidateCommit: env.RENDER_GIT_COMMIT, model: guard.MODEL, modelAccessConfirmed: true, modelAccessEvidenceSha256: "1".repeat(64), providerKeySha256: guard.sha(API_KEY), projectId: "proj_synthetic", standardGlobalTierConfirmed: true, pricingEvidenceSha256: "2".repeat(64), counterBilling: { confirmed: true, flatNanoUsdPerAttempt: 0, evidenceSha256: "3".repeat(64) }, ownerDecisionSha256: "4".repeat(64), packetId: "lpc-assistant-11111111-1111-4111-8111-111111111111", capNanoUsd: 100000000, maxGenerationAttempts: 20, maxCountAttempts: 20, validFromUtc: new Date(Date.now() - 1000).toISOString(), validUntilUtc: new Date(Date.now() + 60000).toISOString(), databaseName: "lpc_staging_shared_20261012", journalCollection: guard.COLLECTION, executionMode: "hosted", allowedFeatures: Object.keys(guard.FEATURES), syntheticSafetyIdentifiers: ["synthetic-subject"], allowedPromptSha256: [guard.sha("Hello synthetic observer")], ...extra };
}
function request(extra = {}) {
  return { method: "POST", headers: { Authorization: "Bearer " + API_KEY, "Content-Type": "application/json" }, body: JSON.stringify({ model: guard.MODEL, instructions: "Only synthetic facts.", input: [{ role: "user", content: JSON.stringify({ userRole: "attorney", latestUserMessage: "Hello synthetic observer" }) }], reasoning: { effort: "low" }, max_output_tokens: 1800, store: false, safety_identifier: "synthetic-subject", metadata: { feature: "lpc_support_manager", role: "attorney" }, ...extra }) };
}
function memoryJournal(cap = 100000000) {
  const records = []; let remaining = cap, halted = false;
  return { records, get remaining() { return remaining; }, get halted() { return halted; },
    async reserve(kind, amount, requestSha256) { assert(!halted && remaining >= amount, "budget exhausted"); remaining -= amount; const r = { kind, reservedNanoUsd: amount, requestSha256, state: "reserved" }; records.push(r); return r; },
    async observe(r, details, actual = null) { assert.equal(r.state, "reserved"); r.state = actual === null ? "unknown_hold_retained" : "known"; r.details = details; r.actualNanoUsd = actual; if (actual !== null) remaining += r.reservedNanoUsd - actual; },
    async halt() { halted = true; },
  };
}
const countResponse = (n = 1000) => new Response(JSON.stringify({ object: "response.input_tokens", input_tokens: n }), { status: 200, headers: { "content-type": "application/json", "x-request-id": "synthetic-count" } });
const answer = (usage = { input_tokens: 1000, output_tokens: 100, input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 } }) => new Response(JSON.stringify({ id: "resp_synthetic", model: guard.MODEL, object: "response", output: [], usage }), { status: 200, headers: { "content-type": "application/json", "x-request-id": "synthetic-answer" } });
const call = (fetch, init = request()) => fetch("https://api.openai.com/v1/responses", init);

test("absent operator gate preserves exact existing client options and shared2retry/30s policy", () => {
  const previous = process.env.LPC_ASSISTANT_BUDGET_GATE; delete process.env.LPC_ASSISTANT_BUDGET_GATE;
  try { const config = require("../ai/config"); assert.deepEqual(config.buildOpenAIClientOptions(API_KEY), { apiKey: API_KEY, timeout: 30000, maxRetries: 2 }); }
  finally { if (previous !== undefined) process.env.LPC_ASSISTANT_BUDGET_GATE = previous; }
});
test("unknown counter billing and model access refuse before either provider endpoint", () => {
  for (const change of [{ counterBilling: { confirmed: false } }, { modelAccessConfirmed: false }, { standardGlobalTierConfirmed: false }]) {
    let calls = 0; assert.throws(() => guard.createGuardedFetch({ authority: authority(change), env, journal: memoryJournal(), transport: async () => { calls += 1; } })); assert.equal(calls, 0);
  }
});
test("production, wrong source, expired, unapproved and excessive budget authority cannot activate", () => {
  for (const e of [{ ...env, NODE_ENV: "production" }, { ...env, RENDER_SERVICE_ID: "prod" }, { ...env, RENDER_GIT_COMMIT: "b".repeat(40) }]) assert.throws(() => guard.validateAuthority(authority(), e));
  for (const a of [authority({ approved: false }), authority({ capNanoUsd: 10000000001 }), authority({ validUntilUtc: new Date(0).toISOString() }), authority({ maxGenerationAttempts: 5623 })]) assert.throws(() => guard.validateAuthority(a, env));
});
test("every request validates exact endpoint, output policy, project/key, subject and approved prompt before network", async () => {
  let calls = 0; const fetch = guard.createGuardedFetch({ authority: authority(), env, journal: memoryJournal(), transport: async () => { calls += 1; } });
  for (const init of [request({ model: "different" }), request({ max_output_tokens: 1900 }), request({ reasoning: { effort: "low", mode: "pro" } }), request({ previous_response_id: "resp_other" }), request({ safety_identifier: "other-subject" }), request({ tools: [{ type: "web_search" }] }), request({ input: [{ role: "user", content: "Unapproved confidential prompt" }] }), { ...request(), headers: { Authorization: "Bearer other" } }, { ...request(), headers: { Authorization: "Bearer " + API_KEY, "OpenAI-Project": "proj_other" } }]) await assert.rejects(call(fetch, init));
  await assert.rejects(fetch("https://elsewhere.invalid/v1/responses", request())); await assert.rejects(fetch("https://api.openai.com/v1/responses/input_tokens", request())); assert.equal(calls, 0);
  await assert.rejects(fetch("https://:synthetic-password@api.openai.com/v1/responses", request()));
  for (const content of [[{ type: "input_image", image_url: "https://elsewhere.invalid/private.png" }], [{ type: "input_text", text: "Unapproved text" }]]) {
    const approved = JSON.parse(request().body).input;
    await assert.rejects(call(fetch, request({ input: [...approved, { role: "user", content }] })));
  }
  for (const output of [[{ type: "input_image", image_url: "https://elsewhere.invalid/private.png" }], [{ type: "input_file", file_id: "file_synthetic" }]]) {
    const approved = JSON.parse(request().body).input;
    await assert.rejects(call(fetch, request({ input: [...approved, { type: "function_call_output", call_id: "call_synthetic", output }] })), /only text function tool output/);
  }
  assert.equal(calls, 0);
});
test("both role manager requests keep original bodies/tools and700/1200/1800output ceilings", () => {
  for (const [feature, [role, max]] of Object.entries(guard.FEATURES)) {
    const init = request({ metadata: { feature, role }, max_output_tokens: max, input: [{ role: "user", content: JSON.stringify({ userRole: role, latestUserMessage: "Hello synthetic observer" }) }], tools: [{ type: "function", name: "synthetic_read", parameters: { type: "object", properties: {} } }] });
    const original = init.body, r = guard.envelope(init.body, authority(), env); assert.equal(init.body, original); assert.deepEqual(r.countBody.input, JSON.parse(original).input); assert.deepEqual(r.countBody.tools, JSON.parse(original).tools); assert.equal(r.countBody.model, guard.MODEL); assert(!Object.hasOwn(r.countBody, "max_output_tokens"));
    for (const output of ['{"synthetic":true}', [{ type: "input_text", text: "Synthetic text result" }]]) {
      const withOutput = JSON.stringify({ ...JSON.parse(init.body), input: [...r.body.input, { type: "function_call_output", call_id: "call_synthetic", output }] });
      assert.deepEqual(guard.envelope(withOutput, authority(), env).body.input.at(-1).output, output);
    }
  }
});
test("exact counted formatting/schema payload reserves before actual transmission and settles only this attempt", async () => {
  const journal = memoryJournal(), init = request({ text: { format: { type: "json_schema", name: "synthetic", schema: { type: "object" } } } }); const sent = [];
  const fetch = guard.createGuardedFetch({ authority: authority(), env, journal, transport: async (url, options) => { assert.equal(journal.records.at(-1).state, "reserved"); assert.equal(options.redirect, "error"); sent.push([url, options.body]); return url.endsWith("input_tokens") ? countResponse() : answer(); } });
  const response = await call(fetch, init); assert.equal(response.status, 200); assert.equal(sent.length, 2); assert.deepEqual(JSON.parse(sent[0][1]).text, JSON.parse(init.body).text); assert.equal(sent[1][1], init.body);
  assert.equal(journal.records[1].reservedNanoUsd, 1000 * 2500 + 1800 * 12000); assert.equal(journal.remaining, 100000000 - (1000 * 2000 + 100 * 12000));
});
test("caller mutation during durable reserve cannot change the counted endpoint method headers or request bytes", async () => {
  const journal = memoryJournal(), baseReserve = journal.reserve.bind(journal), init = request(), original = init.body;
  let release, observed; const blocked = new Promise(resolve => { observed = resolve; });
  const barrier = new Promise(resolve => { release = resolve; });
  journal.reserve = async (...args) => { const record = await baseReserve(...args); if (args[0] === "generation") { observed(); await barrier; } return record; };
  const sent = [], fetch = guard.createGuardedFetch({ authority: authority(), env, journal, transport: async (url, options) => { sent.push({ url, method: options.method, authorization: new Headers(options.headers).get("authorization"), body: options.body }); return url.endsWith("input_tokens") ? countResponse() : answer(); } });
  const url = new URL("https://api.openai.com/v1/responses"), pending = fetch(url, init);
  await blocked; init.body = JSON.stringify({ model: "unapproved", max_output_tokens: 999999 }); init.method = "DELETE"; init.headers.Authorization = "Bearer changed"; url.hostname = "elsewhere.invalid";
  release(); await pending;
  assert.equal(sent.length, 2); assert.equal(sent[1].url, "https://api.openai.com/v1/responses"); assert.equal(sent[1].method, "POST"); assert.equal(sent[1].authorization, "Bearer " + API_KEY); assert.equal(sent[1].body, original);
  assert.equal(journal.records.at(-1).requestSha256, guard.sha(original)); assert.equal(journal.remaining, 100000000 - 3200000);
});
test("unknown timeout holds remain across a fresh guard; a later success cannot refund earlier attempt", async () => {
  const journal = memoryJournal(); let fail = true;
  const transport = async (url) => { if (url.endsWith("input_tokens")) return countResponse(); if (fail) { fail = false; throw new Error("synthetic-uncertain-send"); } return answer(); };
  await assert.rejects(call(guard.createGuardedFetch({ authority: authority(), env, journal, transport })), /synthetic-uncertain-send/);
  const hold = journal.records.find((r) => r.kind === "generation"); assert.equal(hold.state, "unknown_hold_retained");
  await call(guard.createGuardedFetch({ authority: authority(), env, journal, transport })); assert.equal(journal.records.filter((r) => r.kind === "generation").length, 2); assert.equal(journal.remaining, 100000000 - hold.reservedNanoUsd - 3200000);
});
test("missing cache or usage detail retains full current reserve without altering valid response", async () => {
  for (const usage of [{ input_tokens: 1000, output_tokens: 100 }, undefined]) {
    const journal = memoryJournal(); const transport = async (url) => url.endsWith("input_tokens") ? countResponse() : answer(usage === undefined ? {} : usage);
    await call(guard.createGuardedFetch({ authority: authority(), env, journal, transport })); assert.equal(journal.remaining, 100000000 - 24100000); assert.equal(journal.records.at(-1).state, "unknown_hold_retained");
  }
});
test("input count outside shortcontext or unavailable response refuses generation with counter hold preserved", async () => {
  const journal = memoryJournal(); let generation = 0;
  const fetch = guard.createGuardedFetch({ authority: authority(), env, journal, transport: async (url) => { if (!url.endsWith("input_tokens")) generation += 1; return countResponse(272001); } });
  await assert.rejects(call(fetch), /short-context/); assert.equal(generation, 0); assert.equal(journal.records.length, 1); assert.equal(journal.records[0].state, "reserved");
});
test("model usage beyond reserved token ceiling halts before a later provider call", async () => {
  const journal = memoryJournal(); let calls = 0;
  const fetch = guard.createGuardedFetch({ authority: authority(), env, journal, transport: async (url) => { calls += 1; return url.endsWith("input_tokens") ? countResponse() : answer({ input_tokens: 1001, output_tokens: 100 }); } });
  await assert.rejects(call(fetch), /reconciliation/); assert(journal.halted); await assert.rejects(call(fetch)); assert.equal(calls, 2); assert.equal(journal.remaining, 100000000 - 24100000);
});
test("exhausted pre-request reserve and aborted signal cause zero physical generation posts", async () => {
  const journal = memoryJournal(1); let generation = 0;
  const fetch = guard.createGuardedFetch({ authority: authority(), env, journal, transport: async (url) => { if (!url.endsWith("input_tokens")) generation += 1; return countResponse(); } });
  await assert.rejects(call(fetch), /budget exhausted/); assert.equal(generation, 0);
  const controller = new AbortController(); controller.abort(new Error("owned-abort")); await assert.rejects(call(fetch, { ...request(), signal: controller.signal }), /owned-abort/); assert.equal(generation, 0);
});
test("actual installed SDK preserves two retries; each of three real transport attempts gets one own reservation", async () => {
  const OpenAI = require("openai"), journal = memoryJournal(); let generations = 0; const retryHeaders = [];
  const fetch = guard.createGuardedFetch({ authority: authority(), env, journal, transport: async (url, options) => {
    assert.equal(journal.records.at(-1).state, "reserved"); if (url.endsWith("input_tokens")) return countResponse();
    generations += 1; retryHeaders.push(new Headers(options.headers).get("x-stainless-retry-count"));
    return generations < 3 ? new Response(JSON.stringify({ error: { message: "synthetic503", type: "server_error" } }), { status: 503, headers: { "content-type": "application/json", "retry-after-ms": "1" } }) : answer();
  } });
  const client = new OpenAI({ apiKey: API_KEY, fetch, maxRetries: 2 }); const result = await client.responses.create(JSON.parse(request().body));
  assert.equal(result.id, "resp_synthetic"); assert.deepEqual(retryHeaders, ["0", "1", "2"]); assert.equal(generations, 3); assert.equal(journal.records.filter((r) => r.kind === "generation").length, 3); assert.equal(journal.records.filter((r) => r.kind === "count").length, 1); assert.equal(journal.remaining, 100000000 - 2 * 24100000 - 3200000);
});
test("counter flat fee is itself reserved before count; unknown count failure is not refunded", async () => {
  const a = authority({ counterBilling: { confirmed: true, flatNanoUsdPerAttempt: 700, evidenceSha256: "3".repeat(64) } }), journal = memoryJournal();
  const fetch = guard.createGuardedFetch({ authority: a, env, journal, transport: async () => { assert.equal(journal.remaining, 100000000 - 700); throw Error("count-unknown"); } });
  await assert.rejects(call(fetch), /count-unknown/); assert.equal(journal.remaining, 100000000 - 700); assert.equal(journal.records[0].state, "unknown_hold_retained");
});
test("environment activation rejects missing authority/counter confirmation before client setup", () => {
  const fields = ["LPC_ASSISTANT_BUDGET_GATE", "LPC_ASSISTANT_BUDGET_AUTHORITY_FILE", "LPC_ASSISTANT_BUDGET_AUTHORITY_SHA256"], prior = Object.fromEntries(fields.map((k) => [k, process.env[k]]));
  try { process.env.LPC_ASSISTANT_BUDGET_GATE = "true"; delete process.env.LPC_ASSISTANT_BUDGET_AUTHORITY_FILE; delete process.env.LPC_ASSISTANT_BUDGET_AUTHORITY_SHA256; assert.throws(() => guard.fromEnvironment(API_KEY), /pinned authority/); }
  finally { for (const key of fields) { if (prior[key] === undefined) delete process.env[key]; else process.env[key] = prior[key]; } }
});
test("approved curated and hosted entries share one authority balance while hosted subjects remain required", async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "lpc-assistant-entry-")), curated = path.join(folder, "curated.cjs"), hosted = path.join(folder, "hosted.cjs"), previous = process.argv[1];
  fs.writeFileSync(curated, "// approved synthetic curated entry\n"); fs.writeFileSync(hosted, "// approved synthetic hosted entry\n");
  const a = authority({ executionMode: "combined", curatedExecutionConfirmed: true, executionAllowlist: [{ mode: "curated", entrySha256: guard.sha(fs.readFileSync(curated)), features: ["lpc_support_manager"] }, { mode: "hosted", entrySha256: guard.sha(fs.readFileSync(hosted)), features: ["lpc_support_manager"] }] });
  const binding = guard.digest(a), journal = memoryJournal(); let calls = 0;
  const transport = async url => { calls += 1; return url.endsWith("input_tokens") ? countResponse() : answer(); };
  try {
    process.argv[1] = curated; const curatedFetch = guard.createGuardedFetch({ authority: a, env, journal, transport });
    await call(curatedFetch, request({ safety_identifier: undefined }));
    process.argv[1] = hosted; const hostedFetch = guard.createGuardedFetch({ authority: a, env, journal, transport });
    await assert.rejects(call(hostedFetch, request({ safety_identifier: undefined })), /synthetic subject/); assert.equal(calls, 2);
    await assert.rejects(call(curatedFetch), /entry point changed/); assert.equal(calls, 2);
    await call(hostedFetch); assert.equal(calls, 4); assert.equal(journal.remaining, 100000000 - 2 * 3200000); assert.equal(guard.digest(a), binding); assert.equal(journal.records.filter(r => r.kind === "generation").length, 2);
  } finally { process.argv[1] = previous; fs.rmSync(folder, { recursive: true }); }
});
test("unknown or path-spoofed execution entries and ambiguous feature allowlists refuse before transport", async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "lpc-assistant-entry-negative-")), entry = path.join(folder, "entry.cjs"), previous = process.argv[1];
  fs.writeFileSync(entry, "// approved synthetic entry\n"); const fingerprint = guard.sha(fs.readFileSync(entry));
  const a = authority({ executionMode: "combined", curatedExecutionConfirmed: true, executionAllowlist: [{ mode: "curated", entrySha256: fingerprint, features: ["lpc_attorney_support_package7_routing"] }, { mode: "hosted", entrySha256: "e".repeat(64), features: ["lpc_support_manager"] }] });
  let calls = 0; const transport = async () => { calls += 1; };
  try {
    process.argv[1] = entry; const fetch = guard.createGuardedFetch({ authority: a, env, journal: memoryJournal(), transport });
    await assert.rejects(call(fetch), /feature not approved/);
    fs.writeFileSync(entry, "// same path, unapproved bytes\n"); await assert.rejects(call(fetch), /entry point/);
    assert.throws(() => guard.createGuardedFetch({ authority: a, env, journal: memoryJournal(), transport }), /entry point/);
    process.argv[1] = path.join(folder, "missing.cjs"); assert.throws(() => guard.createGuardedFetch({ authority: a, env, journal: memoryJournal(), transport }), /unavailable/);
    assert.throws(() => guard.validateAuthority({ ...a, executionAllowlist: [a.executionAllowlist[0], { ...a.executionAllowlist[1], entrySha256: fingerprint }] }, env), /ambiguous/);
    assert.equal(calls, 0);
  } finally { process.argv[1] = previous; fs.rmSync(folder, { recursive: true }); }
});
test("cache read and write are alternative input categories; missing details retain the entire reserve", () => {
  assert.equal(guard.usageCost({ input_tokens: 1000, output_tokens: 100, input_tokens_details: { cached_tokens: 300, cache_write_tokens: 400 } }, 1000, 1800), 2860000);
  assert.equal(guard.usageCost({ input_tokens: 1000, output_tokens: 100 }, 1000, 1800), null);
  assert.equal(guard.usageCost({ input_tokens: 1000, output_tokens: 100, input_tokens_details: { cached_tokens: 900, cache_write_tokens: 400 } }, 1000, 1800), null);
});
test("metadata URI hash host and database are bound before any independent client is created", async () => {
  const uri = "mongodb+srv://synthetic:local-fixture@metadata.example.invalid/lpc_staging_shared_20261012", a = authority({ journalUriSha256: guard.sha(uri) }), e = { ...env, LPC_ASSISTANT_BUDGET_MONGO_URI: uri, STAGING_MONGO_HOST: "metadata.example.invalid" }; let created = 0;
  const createClient = () => { created += 1; throw Error("must_not_connect"); };
  for (const change of [{ LPC_ASSISTANT_BUDGET_MONGO_URI: undefined }, { LPC_ASSISTANT_BUDGET_MONGO_URI: uri + "changed" }, { STAGING_MONGO_HOST: "different.invalid" }]) assert.throws(() => guard.metadataJournalLease(a, { ...e, ...change }, { createClient }));
  const wrongDatabase = uri.replace("lpc_staging_shared_20261012", "wrong_database"); assert.throws(() => guard.metadataJournalLease({ ...a, journalUriSha256: guard.sha(wrongDatabase) }, { ...e, LPC_ASSISTANT_BUDGET_MONGO_URI: wrongDatabase }, { createClient }));
  const lease = guard.metadataJournalLease(a, e, { createClient }); e.LPC_ASSISTANT_BUDGET_MONGO_URI = uri + "changed";
  await assert.rejects(lease(async () => null), /target changed/); assert.equal(created, 0);
});
test("independent metadata leases close partially connected clients and every throwing callback without shared handles", async () => {
  const uri = "mongodb+srv://synthetic:local-fixture@metadata.example.invalid/lpc_staging_shared_20261012", a = authority({ journalUriSha256: guard.sha(uri) }), e = { ...env, LPC_ASSISTANT_BUDGET_MONGO_URI: uri, STAGING_MONGO_HOST: "metadata.example.invalid" };
  const clients = [];
  const lease = guard.metadataJournalLease(a, e, { createClient: (actual, options) => {
    assert.equal(actual, uri); assert.equal(options.maxPoolSize, 1);
    const item = { connected: 0, closed: 0, dbName: null, async connect() { this.connected += 1; if (clients.length === 1) throw Error("synthetic_connect_failure"); }, db(name) { this.dbName = name; return { collection: () => ({}) }; }, async close() { this.closed += 1; } }; clients.push(item); return item;
  } });
  await assert.rejects(lease(async () => null), /connect_failure/);
  const failures = await Promise.allSettled(Array.from({ length: 3 }, (_, i) => lease(async () => { await Promise.resolve(); throw Error("owned_callback_" + i); })));
  assert(failures.every(r => r.status === "rejected")); assert.equal(clients.length, 4); assert(clients.every(c => c.connected === 1 && c.closed === 1)); assert(clients.slice(1).every(c => c.dbName === a.databaseName));
});
