# Paralegal Assistant Package 5 Implementation

Status: complete

Date: July 23, 2026

## Outcome

Package 5 replaces ad hoc prompt checking with a versioned, generated paralegal evaluation corpus. The corpus contains 551 cases across P01–P32 and carries the complete contract needed by the database, browser, and sanitized live-model packages that follow.

The paralegal manager remains disabled. Package 5 evaluates deterministic planning and the corpus/oracle machinery; it does not claim database, browser, or external-model reliability.

## Generated coverage

Every capability includes:

- multiple positive and paraphrased questions;
- typo and shorthand wording;
- absent, temporarily unavailable, and unauthorized evidence;
- ambiguity requiring one focused clarification;
- prompt-injection and cross-user adversarial requests;
- conversational follow-ups;
- compound questions;
- repeated questions with current evidence reuse.

All cases specify:

- required evidence families, authorized tools, new tool-call expectations, and forbidden tools;
- evidence and authorization states;
- required and forbidden semantic claims;
- answer order, concision, and fallback rules;
- forbidden data classes;
- action, navigation, suggestion, duplicate-link, and review-card rules;
- critical financial, workflow, ownership, privacy, product-accuracy, UI, and legal-boundary risk labels.

## Permanent defect registry

`backend/ai/paralegalSupportProductionDefects.js` registers seven permanent regressions:

1. raw “Verified information” evidence leakage;
2. false payout-timing unavailability;
3. bank-receipt overclaiming;
4. lost follow-up context after selection/invitation;
5. duplicate Contact Us controls;
6. phantom manual review;
7. repeated tool calls when current evidence already contains the answer.

New reported defects can be added to the registry and are automatically converted into permanent corpus cases.

## Structural findings corrected

The first corpus run exposed real semantic-planning gaps. Package 5 corrected the shared paralegal planner by:

- recognizing plural tasks, files, deliverables, revisions, invitations, disputes, and archives;
- separating account-wide matter counts from one completed matter;
- selecting workflow evidence for application and withdrawal eligibility;
- distinguishing message permission from general workspace evidence;
- distinguishing visible moderation state from profile visibility;
- keeping generic “please check this” wording from falsely creating a payout subject;
- selecting approved knowledge for general platform-fee and applying explanations;
- selecting verified Contact Us navigation for human/representative intent;
- ignoring unauthorized cross-user clauses when selecting evidence for the authorized primary question.

These are semantic capability rules, not exact-question or phrase-specific branches.

## Verification

- Corpus version: `2026-07-23.package5.v1`.
- Capability coverage: 32/32.
- Generated cases: 551.
- Critical cases: 551.
- Multi-turn/compound cases: 131.
- Failure/adversarial cases: 160.
- Permanent regressions: 7.
- Deterministic planner/reuse cases: 423/423 passed.
- Cases explicitly deferred to later semantic-model or clarification evaluation: 128.
- Deterministic answer-oracle fixtures: 551/551 passed.
- Critical failures: zero.
- Package 5-focused gate: 2/2 suites and 27/27 tests.
- Complete paralegal Package 2–5 gate: 10/10 suites and 87/87 tests.
- Attorney regression gate: 15/15 suites and 210/210 tests.
- Attorney-assistant source remains unchanged.
- Manager allowlist remains attorney-only.

## Deliberately deferred

- Synthetic database and browser integration: Package 6.
- Sanitized live-model evaluation of the 128 semantic/deferred cases and representative full-pipeline cases: Package 7.
- Reliability telemetry and operations: Package 8.
- Paralegal-only rollout controls and enablement: Package 9.
