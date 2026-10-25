# LPC product experience guide

October 20 local review navigation: [latest focused Search/menu/wording/filter review](http://localhost:5050/lpc-search-no-outline-20261020/) · [revision-request and Search comparison](http://localhost:5050/lpc-final-comments-20261020/) · [full grouped walkthrough](http://localhost:5050/lpc-final-pass-20261020/).

The [61-task evidence register](../outputs/lpc-final-pass-20261020/TASK_RECONCILIATION.md), [journey scorecard](../outputs/lpc-final-pass-20261020/JOURNEY_SCORECARD.md), and [qualified checkpoint](../outputs/lpc-final-pass-20261020/GUIDE_CHECKPOINT_UPDATE.md) retain their dated local scope and source identities. Focused follow-ups retain their own evidence; these links do not claim one new combined run. Existing visual decisions and approval boundaries remain in force. Owner visual acceptance, actual-device/usability checks, hosted/provider evidence and release approval remain separately recorded. No deployment or rollout is implied.

October 20, 2026 · Planning baseline for Samantha and Codex

LPC can deliver the intelligence, ease, familiarity, trust and calm Samantha associates with Stripe. Its existing workflows provide a useful foundation. The remaining work is to make those workflows behave and read as one deliberately designed product, including mobile layouts, errors and recovery. Matching this standard requires shared patterns, accurate state, complete journeys and consistent editorial judgment.

This guide defines the target and execution sequence. It does not authorize a new implementation, rollout or release. The accompanying task register describes work to inspect or perform; its rows are not a count of confirmed defects. Existing approvals remain in force. Samantha retains visual and release approval.

## What Stripe in LPC form means

Stripe is the primary experience reference for the authenticated portals: clear information hierarchy, useful density, recognizable lists and details, consistent actions, purposeful feedback and understandable state. LPC keeps its own fonts, wordmark, colors, content and attorney–paralegal responsibilities. Professional profiles retain their human context.

The benchmark is the user-supplied Stripe Customers screenshot together with Stripe's published design guidance. Stripe Apps documentation supports pattern choices; it does not establish the private Dashboard's source CSS, every current Dashboard behavior or exact pixel values. The LPC dimensions already approved by Samantha remain LPC decisions. [Stripe design patterns](https://docs.stripe.com/stripe-apps/patterns), [full-page patterns](https://docs.stripe.com/stripe-apps/patterns/full-page-apps).

For a person using LPC, success sounds like: “I understand where I am, I know what happens next, and I feel safe doing it.” An attorney can find suitable help, understand a hiring decision, fund permitted work, review a submission and understand its financial outcome. A paralegal can understand an opportunity, apply, recognize when work can begin, submit the right version and understand revisions and compensation.

LPC can be particularly good at these focused relationships. No objective claim that it exceeds every aspect of Stripe is warranted. Product quality is demonstrated by the experience of completing LPC tasks and recovering from problems.

## The current gap

The current review combines delivered synthetic screenshots, their capture code, current source, the exported feedback and existing specifications. The 37 files in the latest feedback candidate still matched its recorded after hashes when this guide was prepared. The Git base is `6cecc07a72a74d4bffd9cd5fa061f738db29d00c`; the working copy contains extensive additional uncommitted work. The commit alone does not identify the complete current product. See the accompanying `baseline.json` for the bounded source identity.

| Goal | Useful foundation already present | Gap visible now or requiring proof | Required outcome |
| --- | --- | --- | --- |
| Intelligence | Matter context, object links, notifications and role-specific actions already exist. | Context is unevenly presented; language still drifts across destinations. A complete paired lifecycle has not been accepted by this review. | Each state makes its owner, meaning and permitted next action clear from authoritative data. |
| Ease | Profile autosave, document actions, direct Work upload and touch-target improvements exist. | Education editing remains ambiguous; Work upload feels disconnected; notes expose too many competing controls. | Common tasks have an obvious entry, few meaningful steps and reliable recovery. |
| Familiarity | Five primary destinations and several shared utilities establish a recognizable structure. | Preferences still uses substantially different layouts, controls and tab order across roles. | Equivalent tasks share recognizable patterns and behaviors. Role-specific capabilities remain distinct. |
| Trust | Existing authorization, guarded writes, payment uncertainty handling and retained history provide important safeguards. | Loose feedback, weak action explanations and incomplete end-to-end proof undermine confidence. Production trust has separate release gates. | State is truthful, saved work is protected, consequences are clear and errors are recoverable. |
| Calm | Approved spacing, the Profile composition, restrained colors and existing motion provide a foundation. | Hierarchy is too flat in places; gaps and toolbar density are inconsistent; the tour opens with excessive empty space. | Attention follows importance; text stays readable; controls fit their information; motion and layout remain stable. |

These are qualitative findings, not a percentage-complete estimate. Intelligence and trust require behavioral evidence beyond screenshots. A static image cannot demonstrate save reliability, permissions, mobile gestures or motion quality.

### Concrete examples from the delivered candidate

1. Education at 320px shows qualification, subject and institution as similar underlined values. The field purpose becomes unclear once a placeholder is replaced. Start and finish grouping improved; the editor still needs a coherent composition.
2. Attorney Preferences presents small theme thumbnails, widely separated controls and a long checkbox list. Paralegal Preferences uses large previews and grouped notification rows. Same options have not produced the same experience.
3. The mobile shortcut capture shows “Page pinned to Shortcuts” as loose text below the row. Its action menu straddles the drawer boundary without a deliberate composition.
4. The populated Profile keeps the approved wide About/Expertise column, but headings, labels, values and Add actions have insufficient hierarchy at the requested light weight.
5. Work exposes Choose files, Submit file, a choose-file instruction and format guidance above a large gap to the work items. Its visual relationship to the submission task is weak.
6. Personal notes presents several week links, month navigation, a date field, a Go to week button and seven textareas together. Autosave did not simplify the overall interaction.
7. Attorney Home still renders “Private tasks,” while the destination is called “Personal tasks & notes.” This is confirmed in `frontend/assets/scripts/attorney-v2/home.mjs`.
8. The four-scene welcome begins with a large logo surface and sparse greeting. The recovered sequence should remain; its first scene has not achieved the requested useful, welcoming quality.

The linked visual appendix in the HTML guide includes these actual screenshots. They are evidence of the local synthetic candidate, not production-user records.

### Why isolated fixes have not closed the gap

Several independently styled implementations perform similar jobs. Both portals load many stylesheets, and some content styles load later. The current HTML contains 35 static stylesheet links for Attorney and 39 for Paralegal. These counts are an architectural warning, not a performance diagnosis. The current feedback stylesheet itself documents overrides needed after lazy-loaded styles. The cascade and component ownership need inspection before more overrides are added.

The older shared specification still recommends 400/500 text, Help at the sidebar foot and device-based Auto appearance. Later user instructions replace those choices. Unreconciled specifications can cause accepted work to regress even when a developer follows a document carefully.

Finally, prior handoffs emphasized implementation checks and screenshot quantity. A screen can pass overflow, API and target-size checks while remaining awkward. Codex must reject obvious composition and interaction problems before returning work for Samantha's taste decisions.

## The five experience contracts

### Intelligence through useful context

Every important record identifies the object, current state, responsible person and valid next step where those facts are available. Home prioritizes confirmed needs for attention. Updates describes an event once and opens its relevant destination. A shared Matter preserves context when moving through Work, Files, Messages, Deadlines and Financials.

Attention derives from existing lifecycle and permission rules. Application acceptance, hiring, funding, file approval, submission approval, Matter completion and payment are distinct where the existing contracts distinguish them. The UI must not infer a new obligation or paid status from a nearby event.

### Ease through continuity

Routine edits stay close to their content. The user can move between supported Profile fields without an immediate Save or Cancel demand. Autosave exposes genuine saving or failure when useful, preserves newer typing and provides the supported undo path. Security, publishing, hiring, payment and other consequential actions retain explicit commitment appropriate to their existing contracts.

Row navigation opens the useful destination directly. Secondary actions remain separate keyboard-accessible controls. A clickable row must not swallow a document menu, selection control or input. Returning to a list preserves supported filter, selection and scroll context.

### Familiarity through shared patterns

Comparable forms, menus, filters, lists, dialogs and feedback use the same visual and behavioral vocabulary. Desktop and mobile use the same mental model with an appropriate layout for each. Reuse shared presentation and interaction code when it reduces drift; retain existing role-specific handlers and server authorization.

Stripe's guidance treats components combined into consistent patterns as the basis of the experience. This supports a shared LPC pattern library; it does not require installing Stripe's Apps SDK or rewriting LPC in another framework. [Stripe pattern guidance](https://docs.stripe.com/stripe-apps/patterns).

### Trust through truthful outcomes

Success is displayed after the relevant operation is confirmed. Loading, unavailable data and genuinely empty data remain distinct. Failed or uncertain writes retain the user's work and explain a safe recovery. A disabled action gives a concise authoritative reason reachable by keyboard and touch, not only hover.

Private account email, documents, personal notes and public-profile information retain their existing visibility boundaries. Photo approval and manual profile hiding remain separate reasons. An Unhide action cannot bypass photo eligibility. Missing dates remain truthful; the date-contract repair stays with its release owner.

### Calm through deliberate hierarchy

Every page has an identifiable purpose and a clear visual order. Headings, values, supporting facts and actions remain distinguishable at the requested font weights. Whitespace groups related material; it does not stretch a short entry into an empty panel. Essential context is visible, optional detail is reachable, and repeated explanations are removed.

Transitions orient the user without moving unrelated content. Existing accepted animations remain. Reduce Motion is honored. Opening and closing, rapid reversal, interrupted loading and the mobile keyboard are part of the interaction design.

## Decisions to preserve

Latest explicit user direction takes precedence over earlier documents. Existing specifications are useful evidence within that boundary. This planning guide does not retroactively approve proposed new dimensions or visual changes.

| Area | Governing decision |
| --- | --- |
| Brand | Keep LPC's exact font family, wordmark and existing brand colors. Personal accents remain private appearance preferences. |
| Protected shell | Preserve the accepted top name, header and primary sidebar geometry, fonts and icons. Repair a verified defect locally; do not reopen the shell composition. |
| Typography | Preserve the genuine light face requested for Profile and affected editors. Do not silently substitute heavier weights, synthesize bold or apply a new global weight reset. Establish hierarchy through size, contrast and spacing. |
| Profile composition | Keep the compact identity header, View profile route, wider About/Expertise column, naturally sized Work experience/Education column, document tiles and compact account footer. |
| Profile data | Preserve all supported fields and multiple entries. Display languages without proficiency; preserve stored proficiency unless a separate data-contract decision changes it. Remove the standalone Best for display; inspect and preserve its data/dependencies, presenting genuine task descriptions within Expertise without duplication. |
| Editing | Preserve current Profile autosave, validation, cancel/revert and undo safeguards. A change in editing scope must preserve the existing save contract; explain any required new semantics first. Do not silently convert all Attorney or Security forms to autosave. |
| Personal Details | Preserve the approved placeholder-only resting visual treatment, accessible field names, two equal name columns stacked on mobile, compact location and a 112px experience field with a years indicator. Dialog maximum 560px, 24px desktop padding, 44px inputs and 16px input text. Do not restore an obsolete Save all footer. |
| Navigation | Help belongs in the name menu; no bottom-left question mark. Account identity opens Profile; Settings opens Preferences. Sign out is red. Keep the accepted centered account photo and compact menu. |
| Spacing | Preserve approved Home/Matters spacing and the deliberate lower calendar/divider position. A prior 40px desktop / 16px mobile gutter target exists, but the latest feedback did not approve a fresh global gutter change. Inventory differences and retain accepted geometry until that specific change is approved. Keep narrower form widths. |
| Row density | Single-line rows may target about 44px where content and controls fit; natural two-line rows around 68px remain appropriate. Never force wrapped content into a fixed single-line height. |
| Availability | Preserve the requested direct range calendar and automatic persistence of a complete valid selection. No Clear/Done requirement, redundant instructional labels or “Unavailable indefinitely” option. Incomplete, invalid and failed selections must remain distinguishable. |
| Appearance | Auto follows local time, not the device theme. Current source resolves light from 7 a.m. to 7 p.m. and dark overnight. Preserve the existing fade; test clock boundaries, return from sleep and explicit override. |
| Shortcuts | Four qualified visits, both roles, individual Matters, recognizable compact rows and natural wrapping. Preserve owner isolation and access checks. Pin/manage controls must work on touch and keyboard. |
| Assistant and motion | Keep the current Assistant presentation per feedback item 24. Preserve accepted animations; any quality correction must retain capability and provide a comparable motion review. |
| Money and dates | Keep payment truth and privacy intact. Translate internal diagnosis into useful user-facing state without hiding a genuine problem. Date-contract repair remains release-owned. |
| Preview and release | One preview at localhost:5050. No push, merge, deployment, attorney rollout, public-homepage rebuild or production writes. Coordinate Settings overlap and preserve newer concurrent fixes. |

## Shared pattern standards

### Typography and information density

Keep the approved 14px / 20px ordinary UI and 13px / 20px secondary metadata where already applicable. Long reading content and inputs retain their appropriate sizes; mobile text inputs remain at least 16px. Profile hierarchy needs a rendered specimen with its genuine light font, not a heavier fallback. A useful specimen includes the name, section heading, field value, long bio, metadata, link, error and selected state.

Measure computed font family, size, line height and loaded face. Inspect actual reading quality in light and dark appearances at default and enlarged text settings. Meet contrast requirements and assess the visual effect of thin strokes; a numeric contrast result alone does not establish comfortable readability. [WCAG contrast guidance](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html).

Spacing uses related increments already present in LPC: 4px internal label/value relationships where appropriate, 8px related horizontal controls, 16px stacked control groups or heading/content, and 24px sections where the Profile direction specifies them. Preserve approved Home's effective 32px section-content-to-next-heading gap. Measure combined margins, padding and min-height. The numbers describe relevant components, not a blanket spacing reset.

### Forms and editing

A field's width should fit the information and work on narrow screens. Names can share a desktop row; years of experience remains compact. About and long document rows can span their section. Editors provide enough context to identify filled values. Samantha's request to remove repeated Personal Details labels does not justify unlabeled, ambiguous Education fields.

Use accessible names even where the visible design relies on placeholders. Keep useful persistent labels in editors with ambiguous values. Errors identify the field, explain a correction and remain available while the user fixes it. Focus indicators are visible. Save, cancel, close and navigation preserve the established persistence rules.

Each editing contract documents its unit of save, validation trigger, debounce/commit behavior, cancellation, undo, server version and uncertain-outcome handling. Empty optional values, deleting an entry and adding a second entry must have explicit behavior. A group editor must not introduce hidden partial saves.

### Menus and overlays

Use a compact anchored menu for short actions, a focused dialog for a bounded task and the existing drawer for its approved workflow. Keep one relevant menu open. Outside click, Escape, selecting an action and route change dismiss appropriately; essential unsaved work uses the existing guard. Focus returns to the originating control where sensible.

Menus stay deliberately positioned within the usable viewport, including a mobile navigation drawer. Dialogs fit the visual viewport when the keyboard is open. Scroll locking does not shift the page horizontally. Opening a menu does not resize the underlying page. Use the appropriate native semantics and WAI keyboard pattern rather than adding ARIA roles without behavior. [Menu button pattern](https://www.w3.org/WAI/ARIA/apg/patterns/menu-button/), [modal dialog pattern](https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/).

### Feedback and recovery

Routine autosave acknowledgment belongs near its field or in an unobtrusive accessible status. A temporary action result can use one consistent toast. Blocking or persistent problems stay with the affected content and recovery. Avoid duplicate confirmations, loose status text inserted into layout, full-page refresh banners for ordinary updates and permanent Saved strips.

Stripe distinguishes temporary action feedback from persistent attention notices. LPC should make the same distinction, adapted to its approved composition and actual failure states. [Communicating state](https://docs.stripe.com/stripe-apps/patterns/communicating-state).

### Lists and filters

Keep single-line rows compact when their controls fit. Multiline titles, counterparty details and dates wrap naturally. The primary row destination is obvious and keyboard accessible. Rare actions use a deliberate overflow menu only when needed. Do not add a redundant View link to a row whose purpose is navigation.

Filters offer actual relevant choices. Active selections are visible and removable. Clear filters affects the intended filter set and preserves unrelated search, sort and view state. A filtered empty result offers recovery appropriate to filtering. Search has a clear purpose and proportional width. [Stripe filter guidance](https://docs.stripe.com/stripe-apps/patterns/filter-controls).

### Responsive behavior and accessibility

Review actual 1440px, 390px and 320px layouts, plus the breakpoint between desktop and mobile. Stack content deliberately. Keep document actions and long names usable. Use LPC's minimum 44px mobile action targets. WCAG 2.2 AA's minimum-target criterion is 24px with exceptions; LPC's 44px touch requirement is deliberately stronger. [Target size guidance](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html).

Verify keyboard traversal, visible focus, accessible names, status announcements, text resizing and reflow. Drawers and dialogs retain their controls with the software keyboard open and at increased text size. No essential operation depends only on hover, color, long press or an undisclosed shortcut. Automated browser checks supplement actual touch-device inspection.

### Motion and performance

Record current accepted motion before editing. Review opening and closing, repeated toggling, rapid reversal, loading interruption and route changes. Match related components' timing and easing where appropriate. Animate the list panel rather than moving its parent navigation row. Preserve the arrow-only hover behavior already requested.

Use existing accepted timings as the first reference. Provisional ranges for a new or corrected pattern are about 120–180ms for local hover feedback, 160–220ms for a small menu and 240–320ms for a drawer; these are LPC review targets, not Stripe CSS or new global overrides. Theme currently uses a 240ms fade. Keep meaningful motion interruptible and honor Reduce Motion.

Measure layout shift and interaction latency on representative tasks; do not infer performance from stylesheet counts or an animation duration. Record device/browser/network conditions. Preserve drafts and visible content during background refresh. Loading stays within the affected region where possible. [Stripe loading guidance](https://docs.stripe.com/stripe-apps/patterns/loading).

## State and save contracts

| Situation | What the user should experience | Required verification |
| --- | --- | --- |
| First load | Relevant loading state with stable layout. | Delayed response never flashes a false empty state. |
| Successful empty load | Concise contextual empty state; an action only when useful. | First use, no results and completed queues are distinguished. |
| Partial source failure | Available content remains, with truthful limits near affected information. | Failure is not represented as zero, complete or paid. |
| Editing | Clear current edit and predictable movement to another supported field. | Pointer and keyboard can continue without a forced premature commitment. |
| Saving | Current value remains visible; useful status reflects the active write. | A slow older response cannot overwrite newer typing. |
| Invalid value | Field-specific correction with retained input. | Invalid data is not announced as saved; other edits follow their documented contract. |
| Save failed | Retained draft and safe retry/revert. | Network failure, denied write and server error are distinguishable where useful. |
| Save outcome uncertain | Draft remains while the existing contract checks the server result. | No duplicate unsafe retry or false success. |
| Concurrent edit | Explain conflict and preserve both relevant versions. | A second tab or stale revision cannot silently win. |
| Undo or revert | Scope and consequences are clear. | Undo restores the intended confirmed value and respects server authority. |
| Upload or document | Truthful missing, selected, uploading, processing, available, failed or restricted state as supported. | View never bypasses authorization or scan/availability restrictions. |
| Disabled action | Concise reason and a valid next step when one exists. | Reason is reachable by keyboard and touch. |
| Access or session loss | Confidential data clears according to existing boundaries; re-entry is understandable. | Wrong account cannot inherit prior drafts, shortcuts, notes or previews. |
| Money pending or uncertain | Status explains the user's situation without internal mode/ledger jargon. | Amounts, totals, dates and actions map to existing authoritative records. |

Stripe explicitly distinguishes loading, error and empty content. LPC must preserve that distinction in every affected destination. [Empty-state guidance](https://docs.stripe.com/stripe-apps/patterns/empty-state).

## Execution sequence

| Wave | Scope | Deliverable and exit condition |
| --- | --- | --- |
| 0 | Reconcile decisions, snapshot current candidate, map capabilities and routes. | Current evidence inventory, protected scope, confirmed defects and unknowns. No product changes. |
| 1 | Establish representative shared patterns. | Actual Education editor, paired Preferences and mobile shortcut feedback/menu examples. Codex performs its own critique before one grouped visual checkpoint. |
| 2 | Finish Profile and account through approved patterns. | Populated/incomplete Profile, editors, documents, photo states, visibility, Preferences and Security on both roles as applicable. |
| 3 | Complete discovery, hiring and the shared Matter journey. | One synthetic attorney–paralegal engagement, including work, revisions, files, messages, dates and truthful financial state. |
| 4 | Align utilities. | Availability, Search, Updates, shortcuts, notes, account menu, Help and recovered tour; Assistant presentation preserved. |
| 5 | Verify the complete candidate and inspect quality. | Interaction, persistence, responsive, accessibility, motion, cross-role and usability evidence. Every required case is passed or explicitly unresolved. |
| 6 | Return for final visual approval and release-owner handoff. | Concise matched gallery, task register, remaining dependencies and exact candidate identity. No automatic release. |

Tasks in a later wave can inform discovery in an earlier wave, but broad rollout of a proposed visual pattern waits for the representative checkpoint. Avoid one approval request per small correction. Finish coherent authorized work, then present a small set of concrete decisions. Repeatedly ask only when an unresolved material choice or contract change genuinely requires Samantha.

### First implementation package after authorization

Start with the current source snapshot and decision ledger. Prepare three representative surfaces: a readable Education editor, equivalent Preferences layouts and a mobile shortcut menu with deliberate feedback. These exercise forms, settings, menus, light typography, responsiveness and both roles. Keep Profile composition, shell dimensions, Home calendar position and current Assistant intact.

Correct the confirmed Home label in the same bounded copy pass. Show actual comparable 1440/390/320 screenshots, one error, one empty state and short opening/closing recordings. Explain each example's relevant save contract. Stop at that grouped visual checkpoint before extending the pattern.

## Journeys that must be covered

| Journey | Roles and context | Success and difficult states |
| --- | --- | --- |
| Enter and return | Both portals, existing entry routes | Login return, refresh, back/forward, old deep link, expired session and access loss preserve valid context. |
| Complete a professional profile | Paralegal and existing Attorney fields as supported | Multiple entries, long bio, optional details, direct editing, validation, save failure, conflict and undo. |
| Manage a profile photo | Existing permitted roles | Choose a new photo, explicit submit-for-approval confirmation, pending/rejected state; crop existing photo without a new moderation review under the existing contract. Mobile pinch, drag and zoom remain usable. |
| View personal documents | Owner only | View supported document, replace, download and remove; missing, scanning, failed, unavailable and unsupported preview paths. |
| Control discovery visibility | Paralegal | Manually hidden profile can be unhidden when eligible; photo approval restrictions explain the exact reason. |
| Find work or a paralegal | Each role's existing discovery | Relevant filters, long results, no match, saved state and return from a profile or opportunity. |
| Apply or invite | Applicant and attorney | Useful details immediately, current status, supported accept/decline/withdraw, stale/expired records and permission changes. |
| Hire and fund | Attorney with permitted participant view | Explicit consequences, authoritative prerequisites, cancel, failure and uncertain result. Preserve business logic. |
| Begin and submit work | Engaged paralegal | Clearly eligible work, right file/version, upload versus submission distinction, failed upload and retry. |
| Review and revise | Attorney then paralegal | Review the actual submission, request revision, respond, approve and understand the next owner. |
| Exchange messages | Same conversation through global and Matter entry | Draft retention, attachment state, send failure, retry, unread synchronization and appropriate return context. |
| Read updates | Bell and full Updates feed | Same record/read state, one event explanation, exact destination, long history and unavailable source. |
| Manage dates and availability | Each permitted role | Existing date editing, personal versus agreed dates, range selection, timezone boundaries and failed availability save. |
| Understand money | Attorney Payments and paralegal Payouts | Pending, confirmed, uncertain, refunded/disputed and historical records where supported; no invented dates or totals. |
| Use personal tools | Existing Attorney capabilities | Create and complete task, edit weekly notes, navigate week, save failure, undo and private visibility. |
| Get help and recover | Both roles | Useful Help entry, relevant Assistant context, history/loading/error behavior and no fabricated successful action. |

Historical, withdrawn, closed, read-only, unavailable and blocked-account contexts must remain reachable under existing permissions. A streamlined interface must conserve supported capabilities and compatible links.

## Quality gates

### Pattern checkpoint

The representative examples must be rendered in the actual local application with synthetic records. Compare before/after at the same viewport, scroll position and comparable data. Include the filled editor, invalid value, mobile keyboard layout, open menu and save-error state. Codex records what is still awkward and corrects objective defects before asking Samantha about taste.

### Functional and trust gate

Every changed action has appropriate focused verification. Shared changes receive checks in both consuming portals. Cover dismissal/focus, validation, saving, failed/uncertain writes, overlapping edits, upload state, route return and access boundaries according to actual impact. Reuse meaningful existing tests; avoid tests that simply restate CSS. Run broader integration checks once the candidate is stable, and repeat only when changes or failures justify it.

### Experience gate

Review a complete task without using developer knowledge to discover controls. A person can identify the record and next action, recover from an ordinary error and understand what is saved or pending. No duplicated headings, ambiguous controls, loose status bars, clipped menus, forced row heights, accidental body movement or unexplained empty states remain in the reviewed scope.

Use the following rubric per journey: 0 means blocked or misleading; 1 means functional but confusing/inconsistent; 2 means clear with a documented minor issue; 3 means coherent and validated. A critical trust/action issue blocks acceptance regardless of the average. Target 3 on all five goals for the accepted journeys. Record the actual observations rather than assigning optimistic scores now.

### Usability evidence

Plan a small moderated round with representative solo/small-firm attorneys and paralegals, provisionally five per role. Participant recruitment and contact require separate authorization. Use synthetic Matters and documents. Observe first click, task completion, hesitation, help requests, mistaken expectations and recovery. Ask participants to explain what happened and who acts next. Treat this as qualitative evidence, not a statistically representative proof.

Critical tasks should be completed without moderator rescue or accidental consequential actions. Every serious misunderstanding becomes a task with an owner. Synthetic automated runs cannot substitute for these observations. Accessibility and real-device inspection remain required alongside the browser matrix.

### Final review and release boundary

The review package groups a small representative set of paired screenshots and clips by journey; full evidence remains available separately. Each item names its route, role, viewport, state and candidate hash. State what is implemented, focused verified, rendered reviewed and owner accepted separately. Production deployment is a further state.

Operational trust includes payment/provider accuracy, mail delivery, document authorization/scanning, session security, recovery and support operations. Those remain governed by `LAUNCH_CHECKLIST.md`, `docs/RELEASE_GATES.md` and `docs/LAUNCH_CERTIFICATION_CURRENT.md`. The current launch document records NO-GO. This experience guide does not replace release evidence or reassign the date-contract repair.

## Task register and execution prompts

The current register contains 61 tasks across seven waves, with 13 reusable execution prompts including the standing contract.

The accompanying `tasks.json` contains dependencies, affected source areas, concrete work, acceptance criteria and verification for each task. `TASKS.md` is the readable checklist. All tasks begin as planned. A task may be satisfied by existing behavior after verification; inspection is not permission to replace accepted code.

`PROMPTS.md` contains the standing execution contract and prompts for discovery, a bounded implementation, save-contract review, paired journeys, copy review, motion review, independent critique, final handoff and safe resumption. The HTML guide provides a search across tasks and a copyable prompt for each task. Use the standing contract with every task prompt.

Required task fields during execution are: status, exact candidate/files, actual evidence, remaining issue, next action, user decision if any and release-owner dependency. Changed work progresses through implemented, focused verified, rendered reviewed and owner accepted. A task satisfied by current behavior can be recorded as verified existing without a code change. Reference an existing approval where its scope remains unchanged; do not reopen it. Deployed remains separate and requires explicit authorization.

### Questions Codex must answer before returning a screen

1. What is the person trying to accomplish, and is the next action obvious?
2. Which facts and controls earn their place on the resting screen?
3. Does an equivalent LPC component already solve this job?
4. Are the content hierarchy and input proportions appropriate at the approved weight?
5. Can a filled field, disabled action and error be understood without guessing?
6. Does the complete task preserve context, drafts and authoritative state?
7. Have both portals and all affected viewport/state combinations been inspected?
8. Did opening, closing, rapid reversal and keyboard use feel deliberate?
9. What evidence supports each completion claim, and what remains unresolved?
10. Would Samantha immediately have to ask about an obvious inconsistency I can already see?

## Deferred ideas

Additional AI automation, ratings/reviews, new matching logic, new payment behavior, new bulk operations, notification channels and new collaboration features remain outside this experience program unless separately requested. Existing useful capabilities stay accessible. Reconsider additions after the core journeys are coherent and observed use identifies a real need.

## Sources

- Samantha's current direction and exported feedback: `outputs/lpc-feedback-implementation-20261020/user-feedback.json`.
- Candidate identity and local evidence: `outputs/lpc-feedback-implementation-20261020/candidate-manifest.json`, `HANDOFF.md`, `gallery-data.json`, screenshots and capture specifications.
- Existing architecture and older visual treatment: `docs/LPC_SHARED_INFORMATION_ARCHITECTURE.md`, `docs/LPC_SHARED_VISUAL_SPEC_V1.md`. Apply later explicit user decisions where these conflict.
- Current launch authority: `LAUNCH_CHECKLIST.md`, `docs/RELEASE_GATES.md`, `docs/LAUNCH_CERTIFICATION_CURRENT.md`.
- [Stripe design patterns](https://docs.stripe.com/stripe-apps/patterns).
- [Stripe full-page patterns](https://docs.stripe.com/stripe-apps/patterns/full-page-apps).
- [Stripe actions](https://docs.stripe.com/stripe-apps/patterns/action-buttons).
- [Stripe filters](https://docs.stripe.com/stripe-apps/patterns/filter-controls).
- [Stripe state communication](https://docs.stripe.com/stripe-apps/patterns/communicating-state).
- [Stripe empty states](https://docs.stripe.com/stripe-apps/patterns/empty-state).
- [Stripe loading](https://docs.stripe.com/stripe-apps/patterns/loading).
- [WAI menu button](https://www.w3.org/WAI/ARIA/apg/patterns/menu-button/), [modal dialog](https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/), [target size](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html), [contrast](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html).

Public sources were accessed October 20, 2026. Pattern choices, priorities and acceptance criteria in this guide are LPC recommendations, except where identified as existing user decisions.

## Execution progress — restrained retry

The first checkpoint’s visual direction was rejected. The retry restores the Before appearance and keeps bounded interaction improvements. Shared Preferences restyling is deferred. See `outputs/lpc-experience-retry-20261020/HANDOFF.md`. This retry awaits visual approval; no wider rollout is implied.

### Mobile deletion follow-up

The user requested a shared left-swipe-to-reveal Delete pattern on appropriate mobile rows. Education, work experience, languages and existing personal tasks/reminders now use the shared presentation while retaining their contracts. Current review: `outputs/lpc-mobile-swipe-delete-20261020/HANDOFF.md`. Both screenshot columns are fresh, synthetic browser captures; visual approval is pending. No wider rollout or release is implied.
