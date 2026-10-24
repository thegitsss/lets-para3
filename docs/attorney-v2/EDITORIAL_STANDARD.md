# Attorney wording and interface standard

Owner direction, September 6, 2026: “i want to make sure that nothing is typical SaaS, or generic wording.” This is a standing requirement for the attorney rebuild, including existing screens. Apply it as part of G-08 and X-07; it is not satisfied by functional tests alone.

## Voice and meaning

Write for an attorney reading quickly between tasks. Use ordinary, precise language that names the Matter, document, applicant, payment or decision involved. Be composed and direct. Avoid sales language, inflated promises, cheerful filler, forced legal jargon and decorative formality.

Use established terms such as Matter, paralegal, application, document, private note, payment and receipt consistently. Keep familiar labels when they accurately describe the action: Save note, Download receipt, Review applications and Request revisions need no invented branded alternatives. Distinguish a posting from an assigned Matter, a payment from a payout, and an archive from deletion.

A heading should identify the content. Supporting text should explain something the heading cannot. Omit repeated role reminders, slogan-like introductions and sentences that merely restate a button. Do not sprinkle “your workspace,” “manage,” “explore,” “all in one place,” “seamless,” “streamline,” “unlock,” “empower,” “supercharge” or “take control” across screens as filler. These are editorial examples, not a blind search-and-replace rule.

Every message must match the information and authority available:

- Name the thing that failed and a useful next action. For example, “Applications couldn’t load. Try again.”
- Show a true empty state only after a successful read. “No applications yet” must not conceal a request failure.
- Confirm the action actually recorded: “Note saved” or “Matter archived.” Avoid “Success!” and vague “Changes applied.”
- Preserve uncertainty. If a save cannot be confirmed, say so and explain how to check it. Do not soften an unresolved financial state into a reassuring success message.
- State consequential effects before confirmation. Say what will be published, charged, paid, reopened or deleted, and for which Matter.
- Explain limitations in terms of the attorney's work. Keep implementation language such as projection, lifecycle state, generation, CAS, canonical record and request receipt out of routine product copy. Use “receipt” for a financial document in the interface, not an internal mutation acknowledgement.
- Preserve essential privacy, funding, retention and access distinctions. A more polished sentence must not imply that a restricted action is available, a refund has settled, or a file has been saved to disk.

## Interface

Use LPC's existing identity and the authenticated-product roles documented in [the visual brand audit](../LPC_VISUAL_BRAND_AUDIT_AND_REMEDIATION.md). The separate public design system is scoped to public pages; do not transplant a marketing layout into legal work.

Organize each screen around the actual task. Prefer readable lists, document details, dates, participants and clear decision groups. Use cards, badges, counts and progress indicators only when they communicate a useful distinction. Avoid decorative metric grids, repetitive welcome panels, promotional banners, celebratory animation, gradients and generic onboarding imagery. A necessary setup checklist can retain its real prerequisites without gamifying them.

Keep the Matter title and relevant context visible. Give the principal action appropriate emphasis, with a quiet cancel or return action. Use the existing typography, spacing, focus and touch-target rules. Distinctive presentation must remain readable and accessible on small screens, with long names and enlarged text.

## Initial review and remaining work

This first source review found generic framing and implementation-oriented explanations. It does not certify every attorney screen or constitute a completed visual redesign.

| Surface | Finding and disposition |
|---|---|
| Shared V2 page headings | Removed the repeated “Your attorney workspace” kicker from built pages and fallback views. Keep the actual page title. |
| Home | Replaced “At a glance” with “Matter summary.” Replaced “A clear view of your Matters and what needs your attention” with “Matters, applications, and upcoming deadlines.” |
| Shell and fallback routes | Repeated “Attorney workspace” labels and navigation-preview/build explanations remain for a coordinated shell and destination pass. Keep navigation and incomplete-feature handoffs accurate. |
| Files and archives | “File records,” “last successful read,” “lifecycle status” and similar explanations need a state-by-state copy pass. Preserve missing-file, security-scan, pause, purge and download-confirmation distinctions. |
| Notes, saved views and posting review | Review recovery/conflict messages for internal terminology and excessive explanation while preserving unsaved edits, exact confirmation and privacy meaning. |
| Receipts and archive exports | Apply this standard during the next implementation. First establish the actual funding/payment/retention state; then write the labels and explanations for that state. No unconditional “Paid in full.” |
| Visual identity | The current V2 stylesheet uses a white/blue palette. Its relationship to LPC's authenticated navy/gold roles needs review under G-08/X-07; this small copy change does not claim to resolve it. |

Review populated, empty, loading, validation, restricted, conflict, unconfirmed and completed states together. Read the complete page aloud and check whether each sentence contributes useful information. Verify real names, amounts, dates and documents in context. Keep the remaining review visible in the checklist rather than treating this document as proof that all copy is finished.

## Evidence for the first correction

The checkpoint is `backend/backups/attorney-v2-editorial-start/`, with 1,475 pre-edit file hashes and exact baselines for the five existing owned files. This change owns six paths: three UI modules, the release identifier, the build checklist and this standard. Financial behavior, data contracts and navigation destinations are unchanged. The summary's derived refresh label is now “Refresh matter summary.” Release `attorney-v2-editorial-20260906` remains disabled with an empty remote cohort.

The existing Home/read-view and navigation checks passed **12/12 across Chromium, Firefox and WebKit**, covering real synthetic server summaries, populated counts/amounts/destinations, persistent navigation, accessibility and layouts from 320px through 1440px with enlarged text. Chromium Home screenshots were visually inspected on desktop and mobile. Changed-module syntax, runtime bindings and frontend hygiene pass. No new tests were added for these small copy edits. All 685 snapshotted application files remained frozen during the browser run. Logs, browser artifacts, final source hashes and the bounded patch are retained in the checkpoint.

These checks verify the first correction. Full editorial and visual acceptance remains open, including the items listed above. No deployment, commit or cohort activation is included.
