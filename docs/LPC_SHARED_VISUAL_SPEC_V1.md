# LPC shared visual specification — version 1

Date: 2026-09-24. Architecture/migration plan approved by the user. This subsequent visual treatment is proposed for review; the preview contains invented sample records and performs no application writes.

Companion: [approved information architecture](LPC_SHARED_INFORMATION_ARCHITECTURE.md). Interactive review source: [paired workspace preview](design-previews/lpc-shared-v1/lpc-shared-workspace.html).

Copy revision: At the user's request, the preview now uses shorter labels, omits explanatory page subtitles and repeated guidance, and places file descriptions and recent updates behind expandable details. This supersedes the longer specimen copy below, without changing navigation or role permissions. Specific action labels such as Approve submission remain explicit. The original 120-check report applies to its recorded source hash; the copy revision receives separate syntax and rendered-layout inspection.

## Deliverables and fidelity

The preview shows both roles in one switchable composition: Home, Matters, the same Matter, and supporting Messages, discovery, and money compositions. Switching roles keeps the current screen and the sample Matter. State controls are review controls outside the depicted product; production does not get a role switcher or a state simulator.

Home, Matters, and the Matter Work view establish the detailed visual direction. Messages, discovery, financial summaries, utilities, and other Matter sections establish placement and hierarchy only. They are not complete specifications of payment, hiring, account, or messaging forms. Existing functionality remains required by the approved architecture; a control absent from this limited specimen is not permission to delete it.

The preview is an isolated design artifact. It does not replace either V2 or demonstrate authenticated application behavior. Preview actions identify themselves as simulations; no send, upload, review, payment, invitation, or record mutation occurs.

## Shared design tokens

| Token | Light | Dark | Use |
| --- | --- | --- | --- |
| Main surface | `#ffffff` | `#18191b` | Content, menus, forms |
| Sidebar | `#f8f9fb` | `#131416` | Shared navigation |
| Primary text | `#263347` | `#e0e3e9` | Headings, body, values |
| Secondary text | `#606c7d` | `#a7aeb9` | Context and metadata; never the only error cue |
| Divider | `#e5e8ee` | `#34373e` | Table/row boundaries |
| Hover surface | `#f3f5f8` | `#24272d` | Hover and neutral notices |
| Selection surface | `#edf2fc` | `#26334c` | Selected nav/view and attention context |
| Accent | `#365f9e` | `#a9c6ff` | Links, active controls, primary action |
| Warning text/mark | `#875a10` | `#e8c27d` | Urgent date/action, always with text |
| Completed mark | `#246748` | `#98d4b2` | Recorded completion, always with text |

Use Sarabun, regular 400 and medium 500. Body 14px/1.5; heading 26px/1.25 desktop and 23px mobile; section heading 17px; item heading 15px; metadata 12px. Preview-only labels can be 11px. Inputs on touch devices are at least 16px. Default spacing uses 4/8/12/16/24/28/32px. Controls have 5px radius; contained file/action surfaces 6px. No shadows on normal work rows. Primary actions use accent fill with the main-surface color for text; selected navigation uses accent text on selection fill.

Preserve system/explicit theme preferences in the actual application. The preview follows its host appearance through theme-aware color pairs. It does not write user preferences.

## Shared shell

At widths above 850px, sidebar 216px and top bar 56px. Sidebar has 10px horizontal padding and 14px top padding. Content padding 28px. At 601–850px, sidebar 184px and content padding 22px. Full application content may expand to 1280px inside the frame; do not stretch text paragraphs beyond readable line lengths.

Primary destinations, in order:

1. Home
2. Matters
3. Messages
4. Find a Paralegal / Find Work
5. Payments / Payouts

Top sidebar account control contains the LPC mark, name, role, and account menu. Profile, Settings, and sign-out live in that account menu; Help is at the sidebar foot. Top bar shows local context at left and Search, notifications, Assistant at right, in that order. The role name is contextual metadata, not a second product brand.

Navigation rows are 38px minimum on desktop, with a 17px icon and 8px icon/label gap. The active destination gets a selection fill and `aria-current=page`. The individual Matter keeps Matters active. Navigation uses labels, not ambiguous icon-only controls. The selected role does not change utility ordering.

At 600px and below, the preview exposes a compact wrapping navigation header with the five labels and a Help control, followed by the 48px utility bar. This is the proposed narrow-screen composition: no squeezed persistent sidebar, no horizontal page scrolling, and no hidden primary destinations. Content padding 16px horizontally and 20px vertically. Touch targets are at least 44px; product implementation must honor zoom/large-text reflow as well as viewport width.

## Home: attention first

One page heading, current date, and one relevant contextual action. Attorney may see New Matter; paralegal may see availability. Neither substitutes for navigation.

Below the heading, a compact summary strip links to the underlying inventories. Suggested role-specific measures: Active Matters; To review / Revisions; Upcoming deadlines. These are record-backed counts, not invented performance indicators. Preserve any additional useful existing summary through the fuller Matters/financial views.

The dominant section is Needs your attention. Rows contain an urgency mark, concise action statement, Matter/context, and a verb-led action at right. Use 64px minimum height, allowing text to wrap. Sort by existing authoritative urgency, deadlines, and required decisions. Never let a visually empty queue imply all work is complete when its sources failed.

Below the attention section: Recent Matters at left, Messages and Recent updates at right. Collapse to one column at 850px. Recent Matters links to the canonical Matter; Messages opens the existing thread; updates open the affected event/file/application. These are previews of the owning destination, not independent stores or full inventories.

Attorney example: “A submission is ready for review” → Review submission. Paralegal at the same instant: the submission is waiting, so it stays in Recent Matters rather than becoming a false required action. An unrelated invitation can be the paralegal's attention item. This preserves role symmetry without inventing symmetrical obligations.

Personal tasks/notes remain accessible below Home content for the attorney. Setup and verification notices appear only when applicable. Paralegal availability remains accessible from Home and Settings.

## Matters: one inventory with meaningful views

Header: Matters, a brief description, and New Matter / Find Work. Under it, lifecycle group controls:

| Attorney | Paralegal |
| --- | --- |
| All, Active, Hiring, Drafts, History | All, Active, Applications, Invitations, History |

These groups are presentation proposals; all existing statuses and histories remain represented. History includes withdrawn/closed/archived records as allowed, not just completed ones. Preserve saved views and filters even if their original controls differ.

The toolbar contains text filtering, a view selector, and Filters. The view selector provides List, Board, Deadlines, Insights. These are renderings of permitted Matter data within Matters, not additional primary destinations. Filters expose Needs attention, Submitted, Revisions, Status, Deadline, and saved views. Applications and Invitations retain their own meaningful actions and details.

List columns: Matter/title/reference, lifecycle status, deadline, and work/submission state. Keep lifecycle and submission state distinct. Show counterparty where needed in the full inventory specification. Rows have 14px vertical padding; labels remain readable. At medium width hide redundant work metadata only when it is available in row detail; at narrow width deadline/counterparty become stacked row details rather than disappearing from the real product. The compact preview hides some optional columns solely to demonstrate reflow; this is not the final data-access implementation.

Board grouping must not enable an invalid status mutation. Deadlines retains the existing cross-Matter date view. Insights retains recorded work totals, completion and review information, links to underlying Matters, and source completeness. Detailed graphs, filter dialogs, saved-view editing, and complete lifecycle inventories require their existing behavior plus subsequent screen-level specification.

## Same Matter: same hierarchy, different controls

Shared sample: Document review · Rivera / LPC-0241, attorney Jordan Lee, paralegal Morgan Ellis, deadline September 28. The sample is fictional.

Order: Back to Matters and switcher; title/reference/lifecycle status; participant and deadline facts; local section navigation; primary section content and contextual actions. The preview shows one sample Matter and therefore omits a single-option switcher; the product retains the real Matter switcher.

Relative section order: Overview, Applications when permitted, Work, Files, Messages, Deadlines, Activity, Financials. A role lacking permission never receives the protected content. Applications may appear for an attorney and a paralegal's own permitted pre-engagement context; an engaged paralegal need not see applicant management.

The Work view uses a single submission notice, followed by the deliverable and its files, then work items. Avoid a competing permanent right-hand panel. File rows include name, author, version, date/size as available, preview/download, and relevant review state.

| Authoritative submission state | Attorney | Paralegal |
| --- | --- | --- |
| Work in progress | Read work/progress and permitted management controls | Upload work; Submit when the contract permits |
| Awaiting review | Review submission; Request revision; Approve submission when permitted | Waiting for attorney review; view/download submitted version; upload only where existing policy allows |
| Revision requested | View request and wait for revised submission | View requested changes; Upload work; Submit revision |
| Approved | View approved work; separate next completion/payment step if required | View approved work and separate payout status |
| Read-only retained record | Permitted history and downloads | Permitted history and downloads |

The preview's default detailed specimen is Awaiting review; the written matrix specifies the other compositions. Actions stay in the same content area even as their availability changes. Confirmations and mutation errors stay beside the relevant action. Upload, submission approval, completion, and payment release must not be visually conflated. Button text should name the exact operation, such as Approve submission, rather than an ambiguous Approve.

Global Messages and Matter Messages use the same thread and draft/read state. The full Messages view supplies a thread list; the Matter view supplies the same conversation within Matter context. Retain a clear return path. Do not redirect a user out of the Matter without preserving their location.

Dates and Activity occupy separate local sections consistently. Financials shows the same engagement context with role-appropriate data and controls. Private notes, payment credentials, other applications, and personal reminders never become shared merely because the layouts match.

## States and interactions

| State | Required visual/interaction behavior |
| --- | --- |
| Loading | Keep shell and page context mounted; show concise loading text or fixed-size content placeholders; no zero counts or empty success queue. |
| Empty | Specific explanation and one meaningful onward action: Create a Matter, Find Work, or View Matters depending on context. Home “caught up” applies only after successful reads. |
| Unavailable | Inline failure message and Retry for the failed section. Successful neighboring sections remain usable. Preview's state selector simulates a whole selected section failing. |
| Partial/stale | Keep last known data identified as stale with its freshness where known; expose failed-source recovery. Counts cannot imply complete coverage. Detailed stale specimen remains part of implementation review. |
| Restricted | Remove inaccessible records and actions, preserve generic context and a safe return. Do not render cached private data behind an error. |
| Read-only | Neutral retained-record notice. Mutations absent or disabled with explanation; permitted history and downloads remain. |
| Action pending | Disable repeated submission for that operation, show progress, retain input and related context. |
| Action failed | Keep draft and inputs; explain next step and show supported retry without losing selection. |
| Action succeeded | Update authoritative state and communicate the actual operation performed. No premature payment/completion claims. |

Navigation must preserve supported drafts, return context, saved filters and object links. Page navigation moves focus appropriately; local view controls have clear selected state and keyboard behavior. Menus and dialogs close on Escape, restore focus to their trigger, and prevent interaction with obscured content where modal. Never depend on hover to reveal essential controls. Avoid entrance animation; honor reduced motion for any transitions.

## Implementation boundary and acceptance

The architecture is approved. The visual treatment in this document/preview is newly presented; the established requirement to approve a detailed visual specification before visual implementation still applies. No application UI, backend, authorization, payment, or production changes are made by this artifact.

Before implementing each slice: record its existing capabilities and exact edit scope, complete the relevant missing detailed form/dialog states, and retain the approved no-loss mappings. Shared changes must be tested against both roles. Do not extend approval of Home/Matter composition to invented payment or lifecycle behavior.

Design-preview verification is recorded separately in `docs/design-previews/lpc-shared-v1/preview-verification.json`. It covers only the isolated artifact. It does not certify live APIs, authenticated access, lifecycle transitions, provider operations, complete accessibility, or whole-project readiness.

For eventual acceptance, render the actual authenticated app as both roles against this specification at 1440, 1024, 736, 390, and 320px, in light/dark and large-text conditions. Compare the same Matter and lifecycle state. Verify retained capabilities, link compatibility, permissions, and backend actions with the appropriate contract/browser suites. Report visual acceptance and functional verification independently.
