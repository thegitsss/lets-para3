# Assistant Replication Plan

Defined: July 22, 2026

The attorney assistant is the reference implementation. This document defines what can be reused and what must be rebuilt for each role. It does not enable paralegal or admin manager behavior.

## Reusable Architecture

The following mechanisms are role-neutral and may be reused after role-specific approval:

- bounded manager loop and structured answer schema;
- deterministic evidence-plan pattern;
- tool trace auditing and bounded validation retry;
- semantic response validation framework;
- safe fallback and response-UI action/suggestion limits;
- privacy-safe reliability aggregation and failure classifications;
- deterministic rollout bucketing, allowlist, kill switch, and observation gates;
- generated evaluation dimensions, synthetic fixtures, and acceptance-first workflow.

## Attorney-Specific Components

These must never be copied as though they were generic:

- `attorneySupportCapabilities.js` capability IDs, sources, limitations, and prompt families;
- attorney workflow policies for posting, hiring, funding, completion, withdrawal, disputes, and archives;
- attorney-only tool schemas, ownership rules, field projections, navigation destinations, and account snapshots;
- financial language from the attorney payer perspective;
- attorney-specific knowledge, boundaries, evaluation oracles, and rollout metrics.

## Paralegal Replication Requirements

Before enabling the manager for paralegals:

1. Inventory paralegal capabilities, authoritative sources, states, permissions, and boundaries independently.
2. Build paralegal-owned/assigned-matter tools that cannot read unrelated attorney or paralegal records.
3. Define payout, application, invitation, task, deliverable, messaging, withdrawal, and profile policy from the paralegal perspective.
4. Create paralegal-specific validators, generated evaluations, isolated database fixtures, response-UI tests, telemetry thresholds, and staged rollout controls.
5. Prove the existing deterministic paralegal assistant remains unchanged until those gates pass.

The hardcoded manager role allowlist remains attorney-only. `OPENAI_SUPPORT_MANAGER_ROLES` cannot bypass it.

## Admin Replication Requirements

Before enabling the manager for admins:

1. Inventory each operational queue and distinguish read-only summaries from privileged actions.
2. Define least-privilege admin tools, field projections, audit requirements, and authorization tiers.
3. Keep approval, rejection, payout, refund, moderation, deletion, impersonation, and other mutations out of the read-only manager unless a separate confirmed action system is approved.
4. Protect internal notes, fraud/risk signals, credentials, payment details, and cross-user information with explicit purpose/role checks.
5. Build admin-specific validators, security/adversarial evaluations, synthetic queue fixtures, UI tests, telemetry, and staged rollout acceptance.

The existing deterministic admin-dashboard support path remains unchanged.

## Deferred Attorney-Supervised Paralegal Work Product

This is a separate future product, not part of support-chat replication. It may eventually support document organization/indexing, neutral chronologies, extraction of names/dates/deadlines, workspace summaries, and clearly labeled draft outlines for an assigned matter.

Required boundaries:

- assigned paralegal plus authorized matter and attorney-provided instruction;
- draft labeling, source references, editability, confidentiality, matter audit history, and supervising-attorney review;
- no legal advice, legal strategy, legal conclusions, unsupervised final legal documents, filing, or external communication;
- explicit attorney approval before any saved/shared output;
- separate threat model, tool contract, evaluation suite, rollout, and product acceptance.
