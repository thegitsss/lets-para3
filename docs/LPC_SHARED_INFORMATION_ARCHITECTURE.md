# Shared LPC information architecture

Date: 2026-09-24

Status: The user approved this architecture and migration plan on 2026-09-24. The next deliverable is the paired visual specification; approval of this plan is recorded separately from approval of its subsequent visual treatment. This is a source-based architecture inventory, not a browser acceptance report or a completed implementation.

Baseline: current working tree at HEAD `6cecc07a7`, including substantial existing uncommitted work. HEAD alone does not identify the inspected source snapshot. No application files were changed for this document.

## 1. Product contract

Attorney LPC and Paralegal LPC are the same product viewed from opposite sides of an engagement.

| Meaning | Attorney | Paralegal |
| --- | --- | --- |
| What needs me | Home | Home |
| Where my work lives | Matters | Matters |
| Where I communicate | Messages | Messages |
| Where I find the other side | Find a Paralegal | Find Work |
| Where my money lives | Payments | Payouts |

These are the only five primary destinations. Files, deadlines, submissions, reviews, applications, updates, activity, and insights retain their functionality within these destinations. Simplifying navigation is not permission to remove capabilities, records, history, filters, or supported workflows.

Use the same order, navigation behavior, typography system, component hierarchy, and utility positions for both roles. Role-specific actions and authoritative access rules remain distinct. Shared architecture does not require an immediate rewrite into one frontend module.

## 2. What the current source establishes

| Finding | Source | Consequence |
| --- | --- | --- |
| Attorney already has five primary entries: Home, Matters, Conversations, Find a Paralegal, Payments. | `frontend/attorney-v2.html` | Rename Conversations to Messages; retain its functionality and compatible links. |
| Paralegal primary/grouped navigation exposes Updates, Inbox, My work, Reviews, Matters, Deadlines, History, Payouts, Work board, Work insights, Matter overview, and discovery/work links. | `frontend/paralegal-v2.html` | Consolidation requires a destination for every existing view, not just hiding sidebar items. |
| Paralegal routes are Home, Browse, Work, Settings, Help, profiles, and individual Matter. Messages and Payouts have no dedicated top-level route definitions. | `frontend/assets/scripts/paralegal-v2/router.mjs` | Dedicated destinations require route and composition work; a label change is insufficient. |
| Paralegal Home currently defaults to a work view. Home work tabs include Assigned, Invitations, Applications, Recommended. | `paralegal-v2/router.mjs`, `home-workspace-model.mjs` | Move work inventory into Matters; make Home an attention summary with explicit onward links. |
| Paralegal Inbox is part of a Home workspace renderer, with message signals alongside other work events. Reviews includes file/revision states. | `paralegal-v2/home-workspace-view.mjs`, `home-workspace-model.mjs` | Preserve non-message events in Home and Matter Activity; construct Messages from actual threads. Do not blindly rename Inbox. |
| Paralegal Payouts links to `#/home?view=history`; Home renders earnings and expected compensation. Completed/withdrawn matters have a separate Work history destination. | `frontend/paralegal-v2.html`, `paralegal-v2/home-view.mjs`, `work-view.mjs` | Separate money history from engagement history while preserving cross-links. |
| Both Matter renderers consume `matterExperience`, whose backend defines common sections and viewer-dependent visibility. | `backend/services/matterExperience.js`, both role workspace renderers | Reuse this authority for symmetry. Do not infer access from sidebar visibility. |
| Attorney Matter message routes currently resolve to Conversations with Matter context. Paralegal messages remain an individual Matter tab. | `attorney-v2/routes.mjs`, `paralegal-v2/deep-links.mjs` | Establish a consistent relationship between global Messages and Matter Messages without duplicating threads or losing context. |
| Backend sections include Deadlines; paralegal supports the tab, while the attorney workspace currently includes dates in Activity and its route matcher does not expose a deadlines tab. | `backend/services/matterExperience.js`, `attorney-v2/routes.mjs`, `workspace.mjs`, `paralegal-v2/deep-links.mjs` | Align placement, retaining existing calendar/date behavior. This is a presentation gap, not proof that attorney deadlines are missing. |

Paths abbreviated with a role directory above are under `frontend/assets/scripts/`.

## 3. Complete destination mapping for the inspected navigation

### Paralegal

| Existing entry/view | Proposed home | Migration treatment and preserved behavior |
| --- | --- | --- |
| Home / default My work | Home | Recompose around prioritized attention, recent Matters, message signals, and conditional setup/availability notices. Full inventories move to Matters. |
| Updates (`home?view=pulse`) | Home > Recent updates; Matter > Activity | Retain events, timestamps, source availability, filtering, and links to the exact affected object. |
| Inbox (`home?view=inbox`) | Home attention for work signals; Messages for threads | Split by actual record type. Existing mixed Inbox links should lead to a compatible Home attention view, not discard non-message items. |
| My work / Assigned | Matters > Active | Retain work items, progress, assignment details, search, filtering, selection, and onward actions. |
| Reviews | Matters > Needs attention / Submitted / Revisions views; Matter > Work and Files | Retain revision requests, awaiting-review states, approved files, review history, preview/download, and submission context. These are work reviews, not necessarily public ratings. |
| Matters | Matters | Merge with the Work inventory without losing pending or historical records. |
| Deadlines | Matters > Deadlines view; Matter > Deadlines | Retain cross-Matter timeline/calendar and individual events. Home surfaces urgent dates. No global primary Deadlines entry. |
| Work board | Matters > Board view | Preserve the board and its filters/grouping. Board position must not invent or mutate server lifecycle states. |
| Work insights | Matters > Insights view | Retain work-item totals, completion measures, under-review counts, charts, and Matter drill-down. Label partial/unavailable sources honestly. |
| Matter overview (`home?view=document`) | Selected Matter > Overview | Preserve facts, progress, latest updates/files, and Matter switching. If an old link lacks a selected Matter, offer selection rather than silently choose the wrong record. |
| My Matters & Applications (`/work`) | Matters | Preserve Active, Applications, Invitations, completed/withdrawn history, and their filters/actions. |
| Applications | Matters > Applications | Preserve status, requested information, permitted withdrawal, agreement/pre-engagement steps, saved filters, and historical applications. |
| Invitations | Matters > Invitations | Preserve invitation details and allowed accept/decline actions. Acceptance does not imply hired or funded. |
| Recommended / Browse matters (`/browse`) | Find Work | Preserve recommendations, discovery filters, details, application entry, and exclusions. Link existing applications back to Matters. |
| History (`/work?section=history`) | Matters > History | Preserve completed, withdrawn, and other retained engagement records and financial links. Do not reduce history to completed-only. |
| Payouts (`home?view=history`) | Payouts | Preserve expected compensation, earnings report, payout statuses, receipts/details where available, and setup links. Expected money must not be relabeled paid money. |
| Attorney profile / own profile | Find Work or Matter contextual profile / account utility | Preserve profile access and return context. No additional primary entry. |
| Profile Settings, Help, Previous workspace | Shared utility positions; temporary compatibility access | Preserve security, preferences, blocked accounts, account closure, support, onboarding, and authorized legacy access until separately retired. |

### Attorney

| Existing entry/view | Proposed home | Migration treatment and preserved behavior |
| --- | --- | --- |
| Home | Home | Prioritized decisions: applications, funding/setup, submissions, revision responses, deadlines, and other authoritative attention signals. |
| Matters; Active, Drafts, Archived; Create new | Matters | Preserve draft creation/editing, publication/moderation, active work, archive/restore, search, filters, and saved views. Add clear access to lifecycle views without adding primary destinations. |
| Matter applications and invitations | Matters > Hiring views; selected Matter > Applications | Preserve candidate decisions, invitation status, pending hire, agreements, and pre-engagement information. |
| Conversations | Messages | Rename visible terminology and preserve thread selection, attachments, unread state, drafts, Matter context, and old routes. |
| Find a Paralegal and candidate profiles | Find a Paralegal | Preserve discovery, profile details, eligibility, invitation, and return context. |
| Payments; setup; Matter financials and receipts | Payments; selected Matter > Financials | Preserve card/setup, funding, payment history, receipts, disputes, withdrawal settlement, and release behavior. |
| Matter work/files/messages/activity | Matching Matter sections below | Retain task/work tracking, submission review, revisions, files, conversation, date controls, and audit history. |
| Matter notes/manage, exports, archive and restore | Matter > Overview/private notes, Activity, and contextual actions | Preserve notes privacy, moderation information, exports/downloads, and archive operations. |
| Private tasks and weekly/monthly notes | Home > Personal tools, with existing deep links retained | Keep private work accessible without a sixth primary destination. Do not turn personal records into shared Matter content. Equivalent paralegal tooling is not presumed implemented. |
| Settings, own profile, Help | Shared utility positions | Retain profile, security, preferences, blocking, closure, support, and setup. |

## 4. Shared Matter workspace proposal

Use one consistent structure for a Matter to which the viewer has access:

1. Back to Matters and Matter switcher in the same position.
2. Header with title, reference if available, authorized participants, lifecycle status, and agreed deadline.
3. A consistent action area describing what needs this viewer. Show only permitted, currently valid controls.
4. Local sections in the same relative order: **Overview, Applications (when permitted), Work, Files, Messages, Deadlines, Activity, Financials**. These are Matter-local sections, never global primary navigation entries.
5. Matching loading, empty, unavailable, restricted, stale, read-only, and action-result states.

Applications is conditional: an attorney may inspect applicants; a paralegal may inspect their own application context where authorized. An applicant does not gain access to the engaged Matter's files, messages, or financials because both roles share the layout.

| Section | Shared content and role differences |
| --- | --- |
| Overview | Scope, participants, key dates, agreement/context, status, and summary. Keep private notes clearly separate from shared facts. |
| Applications | Attorney hiring controls and invitation information; only the paralegal's permitted application/pre-engagement context. |
| Work | Work items and deliverable/submission state. Attorney: Review submission / Request revision / Approve when permitted. Paralegal: Upload work / Submit / Submit revision when permitted. |
| Files | Same organization and version/review context for authorized shared files. Uploading a file does not automatically count as submitting final work. Preserve existing download, preview, security, and retained-file rules. |
| Messages | The Matter's existing conversation. Global Messages indexes these same conversations, with a link back to the Matter and no duplicate message store. |
| Deadlines | Same recorded dates and event history. Editing, proposing, acknowledging, or approving dates follows existing permissions. Personal reminders remain distinguishable from agreed deadlines. |
| Activity | Relevant authoritative history with actor/time/context. Private records and applicant-only information stay scoped. |
| Financials | Same location and underlying engagement context. Attorney sees funding/payment controls; paralegal sees authorized compensation/payout information. Role-private payment details stay private. |

Status vocabulary must describe the same event consistently. Separate Matter lifecycle, application status, deliverable status, and payment status rather than compressing all into one badge. For example, a shared submission state can read “Awaiting review,” with an attorney action “Review submission” and a paralegal explanation “Waiting for attorney review.” This is a proposed presentation mapping, not a new persisted state.

Approval of a file, approval of a submission, Matter completion, and release of money may be distinct operations. Preserve the existing contracts and make their consequences explicit. No navigation change should combine them into one ambiguous “Approve” mutation.

## 5. Shared shell and utility proposal

Use one utility arrangement on desktop: account/profile and Settings in the account menu at the top of the sidebar; Help at the sidebar foot; Search, notifications, and Assistant in the top bar in a consistent order. Mobile uses the same grouping and order within its compact navigation. Exact dimensions, styling, responsive composition, and interaction details belong in the paired visual specification.

The Attorney New Matter action belongs with Matters and can be surfaced contextually on Home. Paralegal availability belongs in profile/settings with a Home shortcut when relevant. Identical utility positions do not require meaningless substitute actions on the other role.

Messages owns communication. Home owns the attention summary. Notifications provide cross-workspace event access. Matter Activity owns the detailed Matter history. A message can appear as a Home/notification signal without becoming a second conversation or a second unread ledger.

## 6. Gaps to resolve before calling the architecture implemented

| Work item | Classification | Completion evidence |
| --- | --- | --- |
| Matching five-item navigation and utility placement | Rename/consolidate | Both roles render with the same hierarchy and utility positions on desktop/mobile. |
| Paralegal top-level Messages | Complete destination using existing messaging behavior | Authorized thread inventory, selection, composer, attachments, unread/read state, drafts, errors, and Matter return paths work. Verify API coverage before assuming a new endpoint is necessary. |
| Paralegal top-level Payouts | Relocate/complete destination | Existing financial reports and setup remain reachable independently of Home; financial statuses and historical access remain accurate. |
| Paralegal Home vs Matters separation | Consolidate | Home prioritizes attention; Matters contains applications, invitations, active/submitted/revision work, history, board, deadlines, and insights. |
| Paired Matter workspace | Align presentation | The same authorized Matter is rendered as both participants; section hierarchy, labels, dates, shared files/conversation, and action positions agree. |
| Attorney date placement and Matter message navigation | Relocate/align | Dates remain editable/readable as permitted; global and Matter message entry preserve conversation identity and return context. |
| Shared status/attention language | Audit/map | Every displayed state maps to authoritative lifecycle, submission, application, or financial data. Missing data is never presented as zero or success. |
| Compatibility and feature conservation | Preserve | Old URLs, notifications, email links, saved views, object IDs, filters, and provider return paths resolve to equivalent context and actions. |

These are source-identified architecture gaps. They do not establish that existing workflows are broken, nor certify the rest of either V2 as complete. Detailed action-by-action inventories and authenticated browser checks remain required before migration.

## 7. Migration sequence and no-loss gates

1. **Freeze the capability inventory.** Expand these navigation mappings into action-level records with source owner, destination, role/access constraints, historical behavior, verification case, and disposition. Include legacy entry points and non-happy paths. Record hashes of the exact allowed edit set because the working tree is already dirty.
2. **Specify the paired screens.** Produce a detailed shared shell, both Home/Matters compositions, and the same Matter shown from each role, including empty/loading/error/restricted/read-only and mobile states. Apply the established visual-spec approval workflow before changing visual implementation. The five-destination decision is already endorsed; this is not a request to reopen it.
3. **Implement destinations and aliases in coherent slices.** Establish Messages and Payouts ownership, consolidated Matters views, and route compatibility before removing old navigation entries. Keep existing backend action contracts and persisted data authoritative.
4. **Align Matter presentation.** Reuse the shared experience model; keep role-specific action handlers and server authorization. Extract shared UI only where that reduces drift without changing business behavior.
5. **Verify both sides together.** Exercise a controlled attorney/paralegal engagement through discovery/application/invitation, permitted hiring and funding, work, messages/files, revision, completion/payment, and retained history. Cover withdrawal, disputes, access loss, rejected/expired applications, and partial service failures as supported by existing contracts.
6. **Remove redundant entry points only after parity is demonstrated.** Every relocated capability has a reachable replacement, compatible old links, and verification evidence. Retirement of V1, release, and deployment are separate decisions; this architecture document does not authorize them.

Required migration checks:

- Old bookmarks, notification/email object links, search results, provider returns, browser back/forward, and refresh preserve the selected Matter/thread/file/application and permitted actions.
- Saved views, filters, scroll/selection where supported, drafts, upload progress, and unsaved edits survive navigation according to explicit behavior.
- Cross-account and applicant/participant boundaries remain enforced server-side; shared layouts do not expose private notes, credentials, payout/card details, or other applicants.
- Messages remains one conversation across entry points, with consistent unread/read behavior and no duplicate sends.
- Historical/read-only Matters remain accessible under existing rules; terminated/withdrawn work and financial records are not silently dropped.
- Board, Insights, Deadlines, Reviews, and Updates have verified homes before their old standalone entries disappear.
- Keyboard/focus behavior, screen-reader labels, light/dark preferences, narrow layouts, long content, and failed/partial loads are checked on both roles.
- Report implemented work, focused tests, broader integration/browser evidence, unresolved gaps, and user acceptance separately. Green tests alone do not certify a visual redesign or whole-LPC readiness.

## 8. Scope of this artifact

This document records the endorsed direction, a current-source navigation inventory, proposed relocation decisions, concrete architecture gaps, and implementation/verification gates. It changes no UI, business logic, permissions, schemas, lifecycle, payment behavior, or production configuration. No authenticated side-by-side visual inspection or test execution was performed for this documentation-only pass.
