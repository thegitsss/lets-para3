# Paralegal Assistant Package 3 Implementation

Status: complete

Date: July 23, 2026

## Outcome

Package 3 added paralegal-specific conversation planning, verified durable entity memory, reference resolution, compound-answer ordering, and evidence-reuse rules. The paralegal manager remains disabled, so these contracts are not yet user-visible.

## Conversation state and authority

- Durable entities are limited to `matter`, `application`, and `invitation`.
- An entity enters memory only from a successful, authorized tool result with verified evidence.
- Tool-derived memory records the entity ID, safe display name, type, related matter ID, and source tool.
- User prose, assistant prose, conversation history, model output, and unverified page context cannot create or prove an entity.
- A page matter/application/invitation ID is only a candidate until it matches authorized durable memory or a tool verifies it.
- Untrusted or malformed persisted entities are discarded.

## Reference handling

- Newly named verified entities replace stale active context.
- Pronouns and short follow-ups use only the verified active entity.
- “The other one” selects a unique verified alternative; multiple alternatives produce one focused clarification.
- “Both” and “all” select only the relevant verified entities.
- Account-wide subject changes clear active matter context while retaining authorized memory for later corrections.
- Named applications and invitations follow the same verified-memory rules as matters.

## Planning and non-repetition

- The evidence planner uses independent paralegal requirements, tools, capability IDs, requested dimensions, and workflow meanings.
- Conversation history may supply topic continuity but never factual evidence.
- Requirements and answer sections are ordered by the user’s question.
- The response-shape contract allows no more than one clarifying question and caps simple compound structure at five sentences.
- Fresh, complete, authorized evidence may be reused only for the same subject.
- A new matter, explicit refresh request, stale evidence, unavailable evidence, missing facts, or a changed subject requires a new tool lookup.
- Repeating the same successful tool for the same subject is classified as redundant.

## Verification

- Current paralegal Package 2–3 contract gate: 7/7 suites, 56/56 tests.
- Attorney assistant non-regression gate: 15/15 suites, 210/210 tests.
- Syntax checks pass for the planner, resolver, and tool evidence timestamp changes.
- Attorney-assistant source and tests remain unchanged.
- The manager role allowlist remains attorney-only.

## Deliberately deferred

- Model generation, bounded validation retries, evidence-backed fallback, and UI filtering: Package 4.
- Generated regression corpus: Package 5.
- Synthetic database and browser integration: Package 6.
- Sanitized live-model evaluation: Package 7.
- Reliability telemetry and operations: Package 8.
- Paralegal-only rollout controls and enablement: Package 9.
