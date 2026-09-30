# LPC Product North Star

This document controls future authenticated LPC product work. LPC's approved, working product is the baseline: enhance it; do not replace it.

## Preserve first

- Preserve existing LPC colors, Cormorant Garamond/Sarabun typography, role-specific character, successful layouts, and working workflows.
- If an experience is already modern, professional, clear, and intentional, leave it alone.
- Rearrangement is appropriate only when it clearly improves organization, hierarchy, navigation, or ease.
- Broad visual redesign requires explicit owner approval.

## Stripe principle

Pursue Stripe-level organization, search, predictable navigation, object relationships, clear status and next actions, progressive disclosure, useful information density, deep links, complete loading/error/empty states, fast-feeling interactions, accessibility, and operational trust. Do not copy Stripe's visual identity.

## Matter principle

Matter is LPC's central operational context. Related functionality should become easier to understand and reach through the Matter without unnecessarily rewriting existing persistence or workflows.

The long-term Matter organization is:

1. Overview
2. Applications
3. Work
4. Files
5. Messages
6. Activity
7. Financials

Only expose sections that actually work; never present fake or empty destinations.

## Architecture restraint

"First-class object" does not automatically require a new Mongo model, migration, backfill, new authority, or parallel source of truth. Prefer existing working LPC records and services. Add projections or adapters only when needed for a correct, safe user experience. Do not build invisible architecture unless it directly enables a user-facing improvement or fixes a proven correctness or security defect.

## Primary actions

Major surfaces should normally present one visually clear primary action based on authoritative state. Secondary actions remain subordinate.

## AI

AI may explain, draft, prepare, search, and navigate. It may not autonomously publish, apply, select, fund, release payment, modify payout setup, or change consequential lifecycle state.

## Development

Localhost, development, and test are the normal development environments. Safe UI and read features must work normally without positive query flags, browser feature flags, cohort enrollment, or percentage-rollout machinery. Gating is reserved for genuine production authority, migration, financial, destructive, or deployment boundaries.

## Roadmap

1. Matter-centered navigation and Global Search.
2. Complete Matter experience.
3. Object deep links, contextual panels, and actionable notifications.
4. Productivity layer: Search refinement, filters, Cmd/Ctrl+K, and contextual AI.
5. Pristine product completion, full journeys, and selective legacy cleanup.

Future prompts must cite this North Star as the controlling product direction. Do not import assumptions from discarded Object System, APS, OS-9A, cohort rollout, or previous modernization work unless the current repository independently requires them.
