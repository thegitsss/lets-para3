"use strict";
const fs = require("node:fs");
const crypto = require("node:crypto");
const MODEL = "gpt-5.6-terra";
const ORIGIN = "https://api.openai.com";
const SERVICE = "srv-d10gdh24d50c73ap2p60";
const COLLECTION = "assistantAcceptanceBudgets";
const PRICES = Object.freeze({ input: 2500, output: 12000 }); // nanoUSD/token, worst short-context input category.
// Actual official model/pricing markdown pinned in the review packet. Standard global tier only.
const CEILING_BILLING = Object.freeze({
  model: MODEL, serviceTier: "default", inputCeilingTokens: 922000, modelOutputCeilingTokens: 128000,
  inputNanoUsdPerToken: 5000, outputNanoUsdPerToken: 18000,
  modelEvidenceSha256: "d6ed1b67c963843adff531428a9c435acecb2ee475048b785377f5bff32437ed",
  pricingEvidenceSha256: "ffcc6656986cdb633e99398e1df49a258ef0cb850769197bba735812bf58e311",
});
// Optional settlement only: full pre-send long-context reservation stays unchanged.
const SHORT_CONTEXT_SETTLEMENT = Object.freeze({
  schemaVersion: 1, confirmed: true, inputThresholdTokens: 272000,
  inputNanoUsdPerToken: 2500, outputNanoUsdPerToken: 12000,
  modelEvidenceSha256: CEILING_BILLING.modelEvidenceSha256,
  pricingEvidenceSha256: CEILING_BILLING.pricingEvidenceSha256,
});
function validateShortContextSettlement(policy) {
  need(policy && Object.keys(policy).length === Object.keys(SHORT_CONTEXT_SETTLEMENT).length && Object.entries(SHORT_CONTEXT_SETTLEMENT).every(([key, value]) => policy[key] === value), "short-context settlement evidence/rates differ");
  return true;
}
// Authenticated cache READ quantity only; every other input token still uses
// the highest category, including any unknown cache-write classification.
const AUTHENTICATED_CACHE_READ_SETTLEMENT = Object.freeze({
  schemaVersion: 1, confirmed: true,
  shortCachedInputNanoUsdPerToken: 200, longCachedInputNanoUsdPerToken: 400,
  pricingEvidenceSha256: CEILING_BILLING.pricingEvidenceSha256,
  cacheUsageEvidenceSha256: "22a81c5b1806d51823166f3d35047ac497fdf1703ad2363ad007f34745fa10c8",
});
function validateAuthenticatedCacheReadSettlement(policy) {
  need(policy && Object.keys(policy).length === Object.keys(AUTHENTICATED_CACHE_READ_SETTLEMENT).length && Object.entries(AUTHENTICATED_CACHE_READ_SETTLEMENT).every(([key, value]) => policy[key] === value), "authenticated cache-read evidence/rates differ");
  return true;
}
// Exact source-coded manager control; optional synthetic acceptance authority only.
// Original request bytes are never rewritten. Error text cannot carry user data.
const TRUSTED_INTERNAL_CONTROL = Object.freeze({
  schemaVersion: 1,
  instruction: "Correct the answer using existing tool evidence. Call another tool only if evidence is insufficient. Do not mention this validation step.",
  maxControlsPerRequest: 2,
  maxErrorCodes: 128,
  sourcePins: Object.freeze({"supportManagerAgent.js": "10b12c3d818390b893ba4e53482b48a6d1f3d52a0f5c02ede3e08097361a0717", "attorneyResponseValidator.js": "2f13f82abb4b995fd5a78c00640aa89e0cc5f0dfade5981cc0fc67b88eea8db0", "attorneyConversationPolicy.js": "261af6fa2905c34901fb82bbedc2395aef221795afbddced6d951178c6053e1a", "attorneyEvidenceContract.js": "c9c1ed793e146703ed10b67cfc0dd4288bbe1253046c6b8ea78d3bd179c2bd43"}),
  errorCodes: Object.freeze(["account_payment_state_not_distinguished", "attorney_charge_not_labeled", "attorney_fee_not_labeled", "case_clarification_too_long", "claimed_data_unavailable_despite_available_evidence", "direct_answer_not_first", "direct_factual_answer_without_successful_tool_evidence", "duplicate_suggestions", "forbidden_action_or_legal_claim", "forbidden_support_meta_claim", "irrelevant_suggestion", "limitation_has_multiple_next_steps", "live_status_without_live_evidence", "matter_amount_not_labeled", "missing_answer_part:application", "missing_answer_part:archive", "missing_answer_part:attorney_fee", "missing_answer_part:charge", "missing_answer_part:deadline", "missing_answer_part:file", "missing_answer_part:invitation", "missing_answer_part:matter_amount", "missing_answer_part:message", "missing_answer_part:paralegal_fee", "missing_answer_part:payment_method", "missing_answer_part:payout", "missing_answer_part:profile", "missing_answer_part:receipt", "missing_answer_part:requirement", "missing_answer_part:status", "missing_answer_part:task", "missing_capability_answer_fact:deposit_release_transition", "missing_capability_answer_fact:deposit_release_trigger", "missing_capability_answer_fact:deposit_timing_source", "missing_capability_answer_fact:deposit_timing_state", "missing_capability_answer_fact:hiring_confirmation", "missing_capability_answer_fact:hiring_selection", "missing_capability_answer_fact:hiring_start", "missing_capability_answer_fact:post_hire_files", "missing_capability_answer_fact:post_hire_messages", "missing_capability_answer_fact:post_hire_status", "missing_capability_answer_fact:post_hire_tasks", "missing_capability_answer_fact:post_hire_workspace", "missing_capability_answer_fact:release_transition", "missing_capability_answer_fact:release_trigger", "missing_net_paralegal_payout", "missing_requested_task_identity", "missing_required_evidence:account", "missing_required_evidence:applications", "missing_required_evidence:attention", "missing_required_evidence:billing_method", "missing_required_evidence:billing_summary", "missing_required_evidence:case_details", "missing_required_evidence:case_overview", "missing_required_evidence:deactivation", "missing_required_evidence:knowledge", "missing_required_evidence:matter_financials", "missing_required_evidence:matter_readiness", "missing_required_evidence:messages", "missing_required_evidence:messaging_state", "missing_required_evidence:navigation", "missing_required_evidence:next_deadline", "missing_required_evidence:pending_paralegal", "missing_required_evidence:receipt_history", "missing_required_evidence:workflow_readiness", "missing_required_evidence:workspace", "missing_total_attorney_charge", "numeric_claim_absent_from_evidence", "paralegal_fee_not_labeled", "paralegal_payout_not_labeled", "planner_wrong_source", "platform_requirement_not_distinguished", "policy_presented_as_live_state", "raw_evidence_fields_exposed", "repeated_tool_after_sufficient_evidence", "simple_fact_too_long", "structured_output_invalid", "suggestion_repeats_answer", "too_many_suggestions_for_simple_answer", "unauthorized_evidence_used_as_fact", "unavailable_evidence_reported_as_absent", "unavailable_evidence_requires_truthful_limitation", "unrelated_billing_or_posting_content", "unrelated_tool_evidence", "unsupported_date_claim", "unsupported_fee_charge_or_payout_claim", "unsupported_invoice_record_claim", "unsupported_name_or_title_claim", "unsupported_receipt_readiness_claim", "unsupported_relative_date_claim", "unsupported_status_or_lifecycle_claim", "untrusted_instruction_content_echoed", "unverified_evidence_presented_as_verified", "validator_internal_error", "workflow_answer_conflicts_with_authoritative_policy", "workflow_prerequisite_without_authoritative_evidence"]),
});
function validateInternalControlPolicy(authority, readFile = fs.readFileSync) {
  const policy = authority.internalValidationControls;
  need(policy && Object.keys(policy).length === 3 && policy.confirmed === true && policy.schemaVersion === 1 && policy.manifestSha256 === digest(TRUSTED_INTERNAL_CONTROL), "trusted internal control authority differs");
  for (const [file, expected] of Object.entries(TRUSTED_INTERNAL_CONTROL.sourcePins)) need(sha(readFile(require("node:path").join(__dirname, file))) === expected, "trusted internal control source differs");
  return true;
}
const FEATURES = Object.freeze({
  lpc_support_manager: ["attorney", 1800],
  lpc_paralegal_support_manager_routing: ["paralegal", 700],
  lpc_paralegal_support_manager_answer: ["paralegal", 1200],
  lpc_attorney_support_package7_routing: ["attorney", 700],
  lpc_paralegal_support_package7_routing: ["paralegal", 700],
  lpc_paralegal_support_package7_e2e: ["paralegal", 1200],
});
const sha = (value) => crypto.createHash("sha256").update(value).digest("hex");
const digest = (value) => sha(JSON.stringify(value));
const integer = (value, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(value) && value >= minimum && value <= maximum;
function deny(message) { const error = new Error("Assistant budget gate: " + message); error.code = "ASSISTANT_BUDGET_REFUSED"; throw error; }
function need(condition, message) { if (!condition) deny(message); }
function validateAuthority(authority, env = process.env, now = Date.now()) {
  need(env.NODE_ENV === "staging" && env.LPC_DEPLOYMENT_ENV === "staging" && env.RENDER_SERVICE_ID === SERVICE, "isolated staging only");
  need(authority?.approved === true && authority.syntheticOnly === true && authority.productionAuthorized === false, "explicit synthetic authority required");
  need(authority.scope === "lpc37-assistant-synthetic-provider-acceptance" && authority.serviceId === SERVICE, "wrong scope/service");
  need(authority.model === MODEL && authority.candidateCommit === env.RENDER_GIT_COMMIT && /^[a-f0-9]{40}$/.test(authority.candidateCommit), "model/source binding differs");
  need(authority.modelAccessConfirmed === true && /^[a-f0-9]{64}$/.test(authority.modelAccessEvidenceSha256 || ""), "model access unconfirmed");
  need(/^[a-f0-9]{64}$/.test(authority.providerKeySha256 || "") && /^proj_[a-zA-Z0-9]+$/.test(authority.projectId || ""), "isolated provider key/project binding missing");
  need(authority.standardGlobalTierConfirmed === true && /^[a-f0-9]{64}$/.test(authority.pricingEvidenceSha256 || ""), "standard/global pricing unconfirmed");
  need([undefined, "exact_counter", "full_model_ceiling"].includes(authority.billingMode), "unknown billing mode");
  if (authority.billingMode === "full_model_ceiling") {
    const evidence = { ...CEILING_BILLING, confirmed: true };
    need(authority.pricingEvidenceSha256 === CEILING_BILLING.pricingEvidenceSha256 && authority.ceilingBilling && Object.keys(authority.ceilingBilling).length === Object.keys(evidence).length && Object.entries(evidence).every(([key, value]) => authority.ceilingBilling[key] === value), "full-model ceiling/pricing evidence unconfirmed/differs");
  } else need(authority.counterBilling?.confirmed === true && integer(authority.counterBilling.flatNanoUsdPerAttempt, 0, 1000000000) && /^[a-f0-9]{64}$/.test(authority.counterBilling.evidenceSha256 || ""), "counter billing unconfirmed");
  need(/^[a-f0-9]{64}$/.test(authority.ownerDecisionSha256 || "") && /^lpc-assistant-[a-f0-9-]{36}$/.test(authority.packetId || ""), "owner/packet binding missing");
  need(integer(authority.capNanoUsd, 1, 10000000000), "cap exceeds proposed10USD");
  need(integer(authority.maxGenerationAttempts, 1, 5622) && integer(authority.maxCountAttempts, 1, 5622), "attempt caps missing/excessive");
  need(Date.parse(authority.validFromUtc) <= now && Date.parse(authority.validUntilUtc) > now && Date.parse(authority.validUntilUtc) - Date.parse(authority.validFromUtc) <= 36 * 3600000, "authority expired/not current");
  need(authority.databaseName === "lpc_staging_shared_20261012" && authority.journalCollection === COLLECTION, "journal must use isolated staging metadata");
  need(["hosted", "curated", "combined"].includes(authority.executionMode), "execution mode missing");
  need(Array.isArray(authority.allowedFeatures) && authority.allowedFeatures.length && authority.allowedFeatures.every((feature) => FEATURES[feature]), "unknown feature");
  need(Array.isArray(authority.syntheticSafetyIdentifiers) && authority.syntheticSafetyIdentifiers.every((value) => typeof value === "string" && value.length >= 8 && value.length <= 200), "synthetic subject scope missing");
  need(Array.isArray(authority.allowedPromptSha256) && authority.allowedPromptSha256.length && authority.allowedPromptSha256.every((value) => /^[a-f0-9]{64}$/.test(value)), "approved synthetic prompts required");
  if (authority.executionMode === "curated") need(authority.curatedExecutionConfirmed === true && /^[a-f0-9]{64}$/.test(authority.curatedScriptSha256 || ""), "curated execution unconfirmed");
  if (authority.executionMode === "combined") {
    const profiles = authority.executionAllowlist;
    need(authority.curatedExecutionConfirmed === true && Array.isArray(profiles) && profiles.length >= 2 && profiles.length <= 5, "combined execution allowlist missing");
    need(profiles.every(profile => ["curated", "hosted"].includes(profile?.mode) && /^[a-f0-9]{64}$/.test(profile.entrySha256 || "") && Array.isArray(profile.features) && profile.features.length && profile.features.every(feature => authority.allowedFeatures.includes(feature))), "execution allowlist invalid");
    need(new Set(profiles.map(profile => profile.entrySha256)).size === profiles.length && profiles.some(profile => profile.mode === "hosted") && profiles.some(profile => profile.mode === "curated"), "ambiguous/incomplete execution allowlist");
  }
  if (authority.shortContextSettlement !== undefined) { need(authority.billingMode === "full_model_ceiling", "short-context settlement requires full ceiling reservation"); validateShortContextSettlement(authority.shortContextSettlement); }
  if (authority.authenticatedCacheReadSettlement !== undefined) { need(authority.billingMode === "full_model_ceiling" && authority.shortContextSettlement !== undefined, "cached-read settlement requires full ceiling and pinned context tiers"); validateAuthenticatedCacheReadSettlement(authority.authenticatedCacheReadSettlement); }
  if (authority.internalValidationControls !== undefined) validateInternalControlPolicy(authority);
  return authority;
}
function resolveExecution(authority, entryFile = process.argv[1]) {
  if (authority.executionMode !== "combined") return { mode: authority.executionMode, features: authority.allowedFeatures };
  let bytes; try { need(typeof entryFile === "string", "entry point missing"); bytes = fs.readFileSync(entryFile); } catch { deny("entry point unavailable"); }
  const matches = authority.executionAllowlist.filter(profile => profile.entrySha256 === sha(bytes));
  need(matches.length === 1, "unapproved/changed execution entry point");
  return matches[0];
}
function initialDocument(authority) {
  return { _id: authority.packetId, binding: digest(authority), remainingNanoUsd: authority.capNanoUsd, generationAttempts: 0, countAttempts: 0, disabled: false, records: [] };
}
function mongoJournal(getCollection, authority) {
  const binding = digest(authority);
  const options = { writeConcern: { w: "majority", j: true }, maxTimeMS: 5000 };
  return {
    async reserve(kind, amount, requestSha256) {
      need(["count", "generation"].includes(kind) && integer(amount) && /^[a-f0-9]{64}$/.test(requestSha256), "invalid reservation");
      const field = kind === "count" ? "countAttempts" : "generationAttempts", cap = kind === "count" ? authority.maxCountAttempts : authority.maxGenerationAttempts;
      const record = { attemptId: crypto.randomUUID(), kind, reservedNanoUsd: amount, requestSha256, state: "reserved", atUtc: new Date().toISOString() };
      const collection = await getCollection();
      const result = await collection.findOneAndUpdate({ _id: authority.packetId, binding, disabled: false, remainingNanoUsd: { $gte: amount, $lte: authority.capNanoUsd }, [field]: { $gte: 0, $lt: cap } }, { $inc: { remainingNanoUsd: -amount, [field]: 1 }, $push: { records: record } }, { ...options, returnDocument: "after", includeResultMetadata: false });
      need(result && result.binding === binding, "durable reservation denied; missing/changed/exhausted journal");
      return record;
    },
    async observe(record, details, knownCostNanoUsd = null) {
      const refund = knownCostNanoUsd === null ? 0 : record.reservedNanoUsd - knownCostNanoUsd;
      need(integer(refund) && integer(knownCostNanoUsd ?? 0), "usage exceeded reserve");
      const collection = await getCollection();
      const result = await collection.updateOne({ _id: authority.packetId, binding, records: { $elemMatch: { attemptId: record.attemptId, state: "reserved", reservedNanoUsd: record.reservedNanoUsd } } }, { $inc: { remainingNanoUsd: refund }, $set: { "records.$.state": knownCostNanoUsd === null ? "unknown_hold_retained" : "known", "records.$.observation": details, "records.$.actualNanoUsd": knownCostNanoUsd } }, options);
      need(result.modifiedCount === 1, "reservation observation unacknowledged/already settled");
    },
    async halt() { const collection = await getCollection(); await collection.updateOne({ _id: authority.packetId, binding }, { $set: { disabled: true } }, options); },
  };
}
function metadataJournalLease(authority, env, { createClient = (uri, options) => new (require("mongoose").mongo.MongoClient)(uri, options) } = {}) {
  const uri = env.LPC_ASSISTANT_BUDGET_MONGO_URI, databaseName = authority.databaseName;
  need(typeof uri === "string" && /^[a-f0-9]{64}$/.test(authority.journalUriSha256 || "") && sha(uri) === authority.journalUriSha256, "private metadata URI binding missing/differs");
  let target; try { target = new URL(uri); } catch { deny("invalid private metadata URI"); }
  need(target.protocol === "mongodb+srv:" && target.hostname === env.STAGING_MONGO_HOST && target.username && target.password && target.pathname === "/" + databaseName && !target.hash && !target.port, "private metadata host/database differs");
  return async function withMetadataJournal(operation) {
    need(env.LPC_ASSISTANT_BUDGET_MONGO_URI === uri && env.STAGING_MONGO_HOST === target.hostname && authority.databaseName === databaseName && sha(uri) === authority.journalUriSha256, "private metadata target changed");
    let client;
    try {
      client = createClient(uri, { maxPoolSize: 1, minPoolSize: 0, serverSelectionTimeoutMS: 5000, connectTimeoutMS: 5000, socketTimeoutMS: 10000, waitQueueTimeoutMS: 5000 });
      await client.connect();
      const collection = client.db(databaseName).collection(COLLECTION);
      return await operation(mongoJournal(() => collection, authority));
    } finally { if (client) await client.close(); }
  };
}
function envelope(raw, authority, env, execution = authority) {
  need(typeof raw === "string" && Buffer.byteLength(raw) <= 2 * 1024 * 1024, "finite JSON body required");
  let body; try { body = JSON.parse(raw); } catch { deny("invalid request JSON"); }
  const keys = new Set(["model", "instructions", "input", "tools", "tool_choice", "parallel_tool_calls", "text", "reasoning", "max_output_tokens", "store", "safety_identifier", "metadata", "service_tier"]);
  need(Object.keys(body).every((key) => keys.has(key)), "unknown model-input/billable feature");
  const feature = body.metadata?.feature, definition = FEATURES[feature];
  need(definition && authority.allowedFeatures.includes(feature) && body.model === MODEL && body.store === false && body.reasoning?.effort === "low", "unapproved model/feature/request policy");
  if (authority.executionMode === "combined") need(execution.features?.includes(feature), "feature not approved for this entry point");
  need(body.metadata.role === undefined || body.metadata.role === definition[0], "role/feature differs");
  need(Object.keys(body.reasoning).length === 1, "unapproved reasoning mode");
  need(body.max_output_tokens === definition[1] && (body.service_tier === undefined || body.service_tier === "default"), "output ceiling/tier differs");
  need(!body.tools || body.tools.every((tool) => tool.type === "function"), "billable built-in tools forbidden");
  need(Array.isArray(body.input), "explicit complete input required");
  const prompts = [];
  let priorApprovedPrompt = false, internalControls = 0;
  for (const item of body.input) {
    need([undefined, "message", "function_call", "function_call_output", "reasoning"].includes(item?.type), "remote/media/stateful input forbidden");
    if (item?.type === "function_call_output") need(typeof item.output === "string" || (Array.isArray(item.output) && item.output.every((part) => part?.type === "input_text" && typeof part.text === "string")), "only text function tool output permitted");
    if (item?.content !== undefined) need(typeof item.content === "string" || (Array.isArray(item.content) && item.content.every((part) => ["input_text", "output_text"].includes(part?.type) && typeof part.text === "string")), "only text message content permitted");
    const userTexts = item?.role !== "user" ? [] : typeof item.content === "string" ? [item.content] : (item.content || []).map(part => part.text);
    for (const text of userTexts) {
      let value;
      try { value = JSON.parse(text); } catch { prompts.push(text); priorApprovedPrompt ||= authority.allowedPromptSha256.includes(sha(text)); continue; }
      if (value?.internalValidationFailure === true) {
        validateInternalControlPolicy(authority);
        need(feature === "lpc_support_manager" && definition[0] === "attorney" && body.metadata.role === "attorney" && priorApprovedPrompt, "internal control requires prior approved attorney prompt");
        need(Object.keys(value).sort().join("|") === "errors|instruction|internalValidationFailure" && value.instruction === TRUSTED_INTERNAL_CONTROL.instruction, "internal control shape/instruction differs");
        need(Array.isArray(value.errors) && value.errors.length > 0 && value.errors.length <= TRUSTED_INTERNAL_CONTROL.maxErrorCodes && value.errors.every(error => typeof error === "string" && TRUSTED_INTERNAL_CONTROL.errorCodes.includes(error)), "internal control error code differs");
        need(++internalControls <= TRUSTED_INTERNAL_CONTROL.maxControlsPerRequest, "internal control bound exceeded");
        continue;
      }
      if (value?.userRole !== undefined) need(value.userRole === definition[0], "input role differs");
      if (typeof value?.latestUserMessage === "string") prompts.push(value.latestUserMessage);
      else if (typeof value?.generationInstructions?.userMessage === "string") prompts.push(value.generationInstructions.userMessage);
      else prompts.push(text);
      priorApprovedPrompt ||= authority.allowedPromptSha256.includes(sha(prompts.at(-1)));
    }
  }
  need(prompts.length > 0 && prompts.every((prompt) => authority.allowedPromptSha256.includes(sha(prompt))), "unapproved synthetic prompt/history");
  if ((execution.mode || authority.executionMode) === "hosted") need(authority.syntheticSafetyIdentifiers.includes(body.safety_identifier), "unapproved synthetic subject");
  require("./attorneySupportLiveEval").assertSanitizedLiveEvalPayload(body, { env });
  const countBody = {};
  for (const key of ["model", "instructions", "input", "tools", "tool_choice", "parallel_tool_calls", "text", "reasoning"]) if (Object.hasOwn(body, key)) countBody[key] = body[key];
  return { body, countBody, requestSha256: sha(raw) };
}
function usageCost(usage, input, outputCeiling) {
  if (usage?.input_tokens === undefined || usage?.output_tokens === undefined) return null;
  const cached = usage?.input_tokens_details?.cached_tokens, written = usage?.input_tokens_details?.cache_write_tokens;
  need(integer(usage?.input_tokens) && usage.input_tokens <= input && integer(usage.output_tokens, 0, outputCeiling), "provider usage exceeds exact count/output ceiling");
  if (!integer(cached) || !integer(written) || cached + written > usage.input_tokens) return null;
  return (usage.input_tokens - cached - written) * 2000 + cached * 200 + written * 2500 + usage.output_tokens * PRICES.output;
}
function ceilingUsageUpperBound(result, outputCeiling, shortContextSettlement, authenticatedCacheReadSettlement) {
  need(result?.model === MODEL && result.service_tier === "default", "provider model/tier differs");
  if (shortContextSettlement !== undefined) validateShortContextSettlement(shortContextSettlement);
  if (authenticatedCacheReadSettlement !== undefined) { need(shortContextSettlement !== undefined, "cached-read settlement requires pinned context tiers"); validateAuthenticatedCacheReadSettlement(authenticatedCacheReadSettlement); }
  const usage = result.usage;
  if (usage?.input_tokens === undefined || usage?.output_tokens === undefined) return null;
  need(integer(usage.input_tokens, 0, CEILING_BILLING.inputCeilingTokens) && integer(usage.output_tokens, 0, outputCeiling), "provider usage exceeds full-model/output ceiling");
  if (usage.total_tokens !== undefined) need(integer(usage.total_tokens) && usage.total_tokens === usage.input_tokens + usage.output_tokens, "provider total usage differs");
  const details = usage.input_tokens_details;
  need(details === undefined || (details !== null && typeof details === "object" && !Array.isArray(details)), "provider cache detail invalid");
  const cached = details?.cached_tokens, written = details?.cache_write_tokens;
  need((cached === undefined || integer(cached, 0, usage.input_tokens)) && (written === undefined || integer(written, 0, usage.input_tokens)) && (cached ?? 0) + (written ?? 0) <= usage.input_tokens, "provider cache usage differs");
  // Only explicitly opted-in, authenticated cache reads use the read category.
  // All remaining input uses the highest category for the authenticated tier.
  // Unknown usage retains the full reserve. This remains an upper bound, never an invoice.
  const rates = shortContextSettlement && usage.input_tokens <= shortContextSettlement.inputThresholdTokens
    ? shortContextSettlement : CEILING_BILLING;
  const cachedRead = authenticatedCacheReadSettlement ? cached ?? 0 : 0;
  const cachedReadRate = rates === shortContextSettlement ? authenticatedCacheReadSettlement?.shortCachedInputNanoUsdPerToken : authenticatedCacheReadSettlement?.longCachedInputNanoUsdPerToken;
  return (usage.input_tokens - cachedRead) * rates.inputNanoUsdPerToken + cachedRead * (cachedReadRate ?? rates.inputNanoUsdPerToken) + usage.output_tokens * rates.outputNanoUsdPerToken;
}
function createGuardedFetch({ authority, env, journal, journalLease, transport = globalThis.fetch, now = Date.now }) {
  validateAuthority(authority, env, now());
  const billingMode = authority.billingMode, fullCeiling = billingMode === "full_model_ceiling", authorityBinding = digest(authority);
  const execution = resolveExecution(authority), executionBinding = digest(execution);
  function validateContext() { validateAuthority(authority, env, now()); need(authority.billingMode === billingMode, "billing mode changed"); if (fullCeiling) need(digest(authority) === authorityBinding, "ceiling authority changed"); need(digest(resolveExecution(authority)) === executionBinding, "execution entry point changed"); }
  need(typeof transport === "function" && ((journal?.reserve && journal?.observe) || typeof journalLease === "function"), "durable store/transport missing");
  const counted = new Map(); let halted = false;
  return async function guardedFetch(url, init = {}) {
    const endpoint = String(url), options = { ...init }, raw = options.body, signal = options.signal;
    need(!halted, "usage bound incident; operator reconciliation required");
    validateContext();
    const destination = new URL(endpoint);
    need(destination.origin === ORIGIN && destination.pathname === "/v1/responses" && !destination.search && !destination.hash && !destination.username && !destination.password && options.method?.toUpperCase() === "POST", "only exact generation endpoint permitted");
    const request = envelope(raw, authority, env, execution), headers = new Headers(options.headers);
    let wire = raw;
    if (fullCeiling && request.body.service_tier === undefined) {
      request.body.service_tier = "default";
      wire = JSON.stringify(request.body);
      headers.delete("content-length");
      request.requestSha256 = sha(wire);
    }
    const authorization = headers.get("authorization") || "";
    need(authorization.startsWith("Bearer ") && sha(authorization.slice(7)) === authority.providerKeySha256, "provider key differs");
    need(!headers.has("openai-project") || headers.get("openai-project") === authority.projectId, "provider project differs");
    const retry = Number(headers.get("x-stainless-retry-count") || "0"); need(integer(retry, 0, 2), "original SDK retry bound exceeded");
    if (signal?.aborted) throw signal.reason;
    const runWithJournal = async journal => {
    validateContext(); if (signal?.aborted) throw signal.reason;
    if (fullCeiling) {
      const reserve = CEILING_BILLING.inputCeilingTokens * CEILING_BILLING.inputNanoUsdPerToken + request.body.max_output_tokens * CEILING_BILLING.outputNanoUsdPerToken;
      const reservation = await journal.reserve("generation", reserve, request.requestSha256);
      validateContext(); if (signal?.aborted) throw signal.reason;
      let response;
      try { response = await transport(endpoint, { ...options, method: "POST", headers, body: wire, redirect: "error" }); }
      catch (error) { await journal.observe(reservation, { outcome: "transport_unknown", sdkRetry: retry, billingMode: "full_model_ceiling", actualBillingKnown: false }); throw error; }
      if (!response.ok) { await journal.observe(reservation, { outcome: "http_unknown_charge", status: response.status, providerRequestId: response.headers.get("x-request-id"), sdkRetry: retry, billingMode: "full_model_ceiling", actualBillingKnown: false }); return response; }
      try {
        const result = await response.clone().json();
        let upperBound;
        try { upperBound = ceilingUsageUpperBound(result, request.body.max_output_tokens, authority.shortContextSettlement, authority.authenticatedCacheReadSettlement); }
        catch (error) { halted = true; await journal.halt?.(); throw error; }
        await journal.observe(reservation, { outcome: "response", status: response.status, providerRequestId: response.headers.get("x-request-id"), sdkRetry: retry, usage: result.usage, billingMode: "full_model_ceiling", costBasis: "conservative_upper_bound", conservativeUpperBoundNanoUsd: upperBound, actualBillingKnown: false, ...(authority.shortContextSettlement ? { settlementPolicySha256: digest(authority.shortContextSettlement), authenticatedResponseModel: result.model, authenticatedResponseServiceTier: result.service_tier, pricingContextTier: result.usage?.input_tokens === undefined ? "unknown" : result.usage.input_tokens <= authority.shortContextSettlement.inputThresholdTokens ? "short" : "long" } : {}), ...(authority.authenticatedCacheReadSettlement ? { cacheReadSettlementPolicySha256: digest(authority.authenticatedCacheReadSettlement), authenticatedCachedReadTokens: result.usage?.input_tokens_details?.cached_tokens ?? null } : {}) }, upperBound);
      } catch (error) { deny("ceiling usage/journal reconciliation failed; full reservation retained"); }
      return response;
    }
    let count = counted.get(request.requestSha256);
    if (!count || now() - count.at > 30000) {
      const countRaw = JSON.stringify(request.countBody), reservation = await journal.reserve("count", authority.counterBilling.flatNanoUsdPerAttempt, sha(countRaw));
      validateContext(); if (signal?.aborted) throw signal.reason;
      // Independent raw count request: no SDK retries or recursion; complete model-input fields preserved.
      let response;
      const countHeaders = new Headers(headers); countHeaders.delete("content-length"); countHeaders.set("x-stainless-retry-count", "0");
      try { response = await transport(ORIGIN + "/v1/responses/input_tokens", { method: "POST", headers: countHeaders, body: countRaw, signal, redirect: "error" }); }
      catch (error) { await journal.observe(reservation, { outcome: "transport_unknown" }); throw error; }
      let result; try { result = await response.json(); } catch { await journal.observe(reservation, { outcome: "invalid_count_response", status: response.status }); deny("count response unavailable"); }
      need(response.ok && result.object === "response.input_tokens" && integer(result.input_tokens, 1, 272000), "exact short-context count unavailable");
      await journal.observe(reservation, { outcome: "counted", inputTokens: result.input_tokens, providerRequestId: response.headers.get("x-request-id") }, authority.counterBilling.flatNanoUsdPerAttempt);
      count = { input: result.input_tokens, at: now() }; counted.set(request.requestSha256, count);
    }
    // Revalidate time/authority and the same immutable bytes after counting, before reserving/sending.
    validateContext();
    if (signal?.aborted) throw signal.reason;
    const reserve = count.input * PRICES.input + request.body.max_output_tokens * PRICES.output;
    const reservation = await journal.reserve("generation", reserve, request.requestSha256);
    validateContext(); if (signal?.aborted) throw signal.reason;
    let response;
    try { response = await transport(endpoint, { ...options, method: "POST", headers, body: raw, redirect: "error" }); }
    catch (error) { await journal.observe(reservation, { outcome: "transport_unknown", sdkRetry: retry }); throw error; }
    if (!response.ok) { await journal.observe(reservation, { outcome: "http_unknown_charge", status: response.status, providerRequestId: response.headers.get("x-request-id"), sdkRetry: retry }); return response; }
    // Original response remains intact for SDK parsing. Missing/unknown usage keeps this attempt's reserve.
    try {
      const result = await response.clone().json();
      let cost;
      try { cost = usageCost(result.usage, count.input, request.body.max_output_tokens); }
      catch (error) { halted = true; await journal.halt?.(); throw error; }
      await journal.observe(reservation, { outcome: "response", status: response.status, providerRequestId: response.headers.get("x-request-id"), sdkRetry: retry, usage: result.usage }, cost);
    } catch (error) { deny("usage/journal reconciliation failed; full reservation retained"); }
    return response;
    };
    return journalLease ? journalLease(runWithJournal) : runWithJournal(journal);
  };
}
let environmentFetch, environmentAuthority;
function fromEnvironment(apiKey) {
  need(process.env.LPC_ASSISTANT_BUDGET_GATE === "true", "explicit gate=true required");
  if (environmentFetch) { validateAuthority(environmentAuthority, process.env); need(sha(apiKey || "") === environmentAuthority.providerKeySha256, "provider key differs"); return environmentFetch; }
  const file = process.env.LPC_ASSISTANT_BUDGET_AUTHORITY_FILE, expected = process.env.LPC_ASSISTANT_BUDGET_AUTHORITY_SHA256;
  need(typeof file === "string" && /^[a-f0-9]{64}$/.test(expected || ""), "pinned authority file missing");
  const bytes = fs.readFileSync(file); need(sha(bytes) === expected, "authority bytes differ");
  const authority = validateAuthority(JSON.parse(bytes), process.env);
  need(sha(apiKey || "") === authority.providerKeySha256, "provider key differs");
  if (authority.executionMode === "curated") { need(process.argv[1] && sha(fs.readFileSync(process.argv[1])) === authority.curatedScriptSha256, "curated script differs"); }
  const journalLease = metadataJournalLease(authority, process.env);
  environmentFetch = createGuardedFetch({ authority, env: process.env, journalLease });
  environmentAuthority = authority;
  return environmentFetch;
}
module.exports = { MODEL, FEATURES, COLLECTION, TRUSTED_INTERNAL_CONTROL, validateInternalControlPolicy, CEILING_BILLING, SHORT_CONTEXT_SETTLEMENT, validateShortContextSettlement, AUTHENTICATED_CACHE_READ_SETTLEMENT, validateAuthenticatedCacheReadSettlement, sha, digest, validateAuthority, resolveExecution, initialDocument, mongoJournal, metadataJournalLease, envelope, usageCost, ceilingUsageUpperBound, createGuardedFetch, fromEnvironment };
