# Linear homepage desktop: live reference audit

Inspected on 2026-09-08 at **https://linear.app/**. This is the publicly accessible interactive desktop embedded in Linear's homepage, whose accessible label begins “A screenshot of the Linear app…”. It is not a private authenticated Linear workspace. No signup or login was performed. Every navigation item that opens a distinct desktop view was entered; individual control results and limits are recorded below.

The browser was set to **1440 × 1100 CSS pixels** and the embedded desktop was scrolled into view. Screenshots were captured from the actual rendered browser and then opened for visual inspection. The page URL stayed `https://linear.app/` throughout the in-demo navigation. This audit used the purpose-built Playwright MCP; the separate CUA browser was unavailable. The public browser was closed after the audit.

## Measured geometry

Values below come from rendered element bounding boxes and computed styles, not estimates from an image. The same frame and navigation geometry held across the inspected desktop views.

| Element | Measured value | Application to LPC |
| --- | --- | --- |
| Embedded desktop | 1320 × 720 px; 12 px outer radius; 8 px padding | Compact desktop proportions and one containing frame. The marketing embed's fixed width should not silently dictate app behavior at larger viewports. |
| Sidebar | 232 × 704 px | Stable left navigation rail. |
| Sidebar content rows | 208 × 28 px; 2 px gap; 7 px horizontal padding | Short operational labels, compact icons, consistent row rhythm. |
| Workspace identity row | 208 × 28 px; identity button about 97 px wide; search/new buttons 28 × 28 px | Identity and primary utilities share one compact top row. |
| Sidebar group label | 208 × 24 px; 12 px type / 14 px line height; padding 4 px 0 4 px 6 px | Clear grouping without a large heading. |
| Sidebar text | 13 px; computed variable weight 510; Inter Variable stack | Match density using LPC's approved Sarabun family and real available weights. Do not import Linear's font. |
| Main inner panel | 1070 × 702 px | Single persistent work surface. |
| Main location/header bar | 44 px high | Compact location and contextual tools. |
| Secondary toolbar | 44 px high, containing 28 px controls | Tabs/filter/display controls share one line. |
| Standard issue detail | Main article wrapper 662 px, inner title/activity content 630 px; right properties 286 px; title 20 px with 27 px box | Reading column plus separate factual properties. |
| Detail property rows | 24 px high, generally 30 px cadence | Facts remain compact and separate from narrative/activity. |
| Inbox split | 319 px list pane + 751 px detail pane | Stable master/detail view rather than a modal covering the queue. |
| Inbox list items | 294 × 56 px with 2 px vertical gaps, within 318 px inner list | Two-line notification summary, time/status at the right. |
| Reviews split | Same 319 / 751 px; review items 300 × 63 px | Queue and selected record stay visible together. |
| My issues | 36 px group headers; 40 px issue rows; 1054 px row width | Dense grouped operational rows. |
| Pulse | Centered 720 px feed; individual entries use about 24 px body line height | Narrative updates can use a narrower column than a data list. |
| Initiatives | 56 px table rows; 40 px column heading row | Fixed columns align target, health, project counts, and activity. |
| Projects | Timeline row cadence 108 px; month scale 160 px | A distinct timeline presentation, not ordinary stacked cards. |
| Agent tasks | Three 338 px columns, 12 px gaps, 16 px outer inset; 47 px column headings; 96 px cards with 8 px gaps | Board is a true alternate presentation of work groups. |
| Agent Insights | Three approximately 335 × 104 px metrics; two 511 px lower panels; 16 px gaps/inset | Metrics are confined to a separate analysis view. |
| UI Refresh overview | Centered 720 px document; 24 px inline property chips; 40 px property-line cadence | Project document has a different reading composition from an issue list. |
| Floating agent demonstration | 400 × 520 px | Reference for a compact contextual tool window only. Its demo controls are not evidence of production functionality. |
| Workspace menu | 210 × 74 px; two 208 × 32 px menu items | Small anchored menu, with Escape dismissal. |

The reference uses a dark palette, colored status icons, tinted panels, and Inter. Those visual tokens are reference observations, not LPC tokens. LPC's approved Home white/navy/cornflower and Sarabun constraints remain the implementation authority. See [the original reference and token audit](PARALEGAL_HOME_REFERENCES.md).

## Actual interaction results

“No visible result” means the click was delivered and the inspected content/overlay state did not change. It does not establish how the authenticated product behaves. Many homepage controls have hover/focus appearance while retaining static sample content.

| Surface | Controls actually exercised | Observed result |
| --- | --- | --- |
| Main sidebar navigation | Pulse, Inbox, My issues, Reviews, Initiatives, Projects, Faster app launch, Agent tasks, Agent Insights, UI Refresh | All **10 distinct views** replaced the main panel while preserving the sidebar and outer frame. URL stayed on the homepage. |
| Sidebar utilities | Workspace logo/menu; Search workspace; New issue; More; Workspace and Favorites group headings | Logo opened Settings / Log out menu; Escape dismissed it. Search and New issue opened no field/dialog. More opened no menu. Group headings did not collapse their rows. |
| Pulse | Popular, Recent, Save view, Subscribe, New update, first update's actions, Comment, existing flame reaction, Add reaction | Existing flame reaction incremented from 2 to 3. Other tested controls did not change the feed or expose an inspected menu/editor. |
| My issues | Created, Subscribed, Activity, Filter issues, Display options, Insights, Toggle sidebar | Same grouped issue list remained. No filter/display/insights panel appeared and sidebar width remained 232 px. |
| Reviews | Created, Activity, Guide, Diff, Preview, Inspect, More options, History, second review row | The same selected record and displayed code diff remained. No inspected overlay appeared. |
| Initiatives | Planned, All initiatives, New initiative, Infra stability row | Table retained the same content. No creation dialog or record detail opened. |
| Projects | My projects, All initiatives, Roadmap timeline, 15 more, Filter projects, Display options, Toggle sidebar, New project | Timeline retained the same content; no inspected overlay appeared. |
| Agent tasks | Active, Backlog, View options, Filter tasks, first Column options, first New task, Faster app launch card | Board retained the same content; no inspected overlay appeared. The card did not open the issue, whereas the sidebar favorite did. |
| Agent Insights | Dashboard actions, Save view, New insight | Metrics/chart/table remained; no inspected overlay appeared. |
| UI Refresh | Activity, Customers, Issues, Project options, Properties, In Progress property, Design explorations resource | Project overview remained; no inspected property editor/resource view appeared. |
| Faster app launch detail | Issue options, Previous issue, Next issue, all three copy controls, Delegate to an agent, More delegation options | Record and index stayed at the initial issue and 1 / 84. No options/delegation menu appeared. Copy controls had no visible confirmation; clipboard content was not read, so successful copying is not claimed. |
| Detail favorite | Remove from favorites, then Add to favorites | Accessible label toggled and the star state changed; static sidebar favorite remained present. The original favorite state was restored. |
| Inbox | All, Unread, Snoozed, the other three notification rows, Show more | Same list and initial selected issue remained; Show more did not expand the triage block. |
| Inbox comment field | Entered an explicit unsent reference draft, inspected, then cleared | Text entry and focus styling worked. No comment was submitted. |

The agent window in the initial issue view animates by itself. During inspection it advanced through a sample prompt, thinking state, and draft change summary without a user submission. Its minimize, maximize, and close symbols are inside an `aria-hidden` container of spans rather than accessible buttons. The “Reply” appearance is also part of the illustrated sequence. The presence of those symbols is not proof that a working assistant was exercised.

All important desktop compositions were inspected. This is not a claim that every repeated property chip, reaction, or state-changing action was executed. Settings and Log out were inspected as menu items but not activated. Clear inbox, Mark as done, review completion, subscription changes outside the tested Pulse button, comment submission, external signup, and authenticated persistence were not tested. Most individual property values were visually inspected; the explicit property click coverage is the UI Refresh Properties/In Progress pair above.

An attempted unsafe Playwright batch was rejected by automatic approval review because it used arbitrary server-side execution and included a potentially destructive Clear inbox action. No action in that rejected batch ran. Subsequent inspection used ordinary browser navigation/read controls and omitted Clear inbox. The read-only Reviews controls were then exercised individually. This limitation must remain explicit in any claim about complete interaction coverage.

## Screenshot evidence

All files below were opened and visually inspected. Each numbered desktop capture except the menu is exactly 1320 × 720 CSS pixels. The menu capture is the full 1440 × 1100 viewport so its anchor and homepage context are visible.

| Capture | Evidence |
| --- | --- |
| [01 Inbox](design-previews/paralegal-linear/reference/01-inbox.png) | Three-pane composition; notification queue; selected issue and comment field. |
| [02 Pulse](design-previews/paralegal-linear/reference/02-pulse.png) | Centered update feed with compact reactions. |
| [03 Workspace menu](design-previews/paralegal-linear/reference/03-workspace-menu.png) | Actual open menu containing Settings and Log out. |
| [04 My issues](design-previews/paralegal-linear/reference/04-my-issues.png) | Group headers, 40 px rows, aligned right metadata. |
| [05 Reviews](design-previews/paralegal-linear/reference/05-reviews.png) | Review queue and selected diff. |
| [06 Initiatives](design-previews/paralegal-linear/reference/06-initiatives.png) | Hierarchical table with fixed fact columns. |
| [07 Projects](design-previews/paralegal-linear/reference/07-projects.png) | Timeline and milestones. |
| [08 Agent tasks](design-previews/paralegal-linear/reference/08-agent-tasks.png) | Three-column board. |
| [09 Agent Insights](design-previews/paralegal-linear/reference/09-agent-insights.png) | Metrics, stacked chart, and tabular breakdown. |
| [10 UI Refresh](design-previews/paralegal-linear/reference/10-ui-refresh.png) | Project document and inline properties. |
| [11 Issue detail](design-previews/paralegal-linear/reference/11-issue-detail.png) | Article/properties layout with the automatic agent animation visible. |
| [12 Inbox draft](design-previews/paralegal-linear/reference/12-inbox-draft.png) | Actual editable comment field and focus appearance; unsent draft was later cleared. |

[Final frame measurement confirmation](design-previews/paralegal-linear/reference/measurement-confirmation.txt) records the source URL, 1320 × 720 frame, and 232 px sidebar at the end of the session.

## LPC implementation and review implications

Use the stable rail, compact header/tool rows, aligned data rows, selectable record presentation, contextual properties, and genuine alternate list/board views. LPC actions should reach existing authorized LPC destinations and data, with visible failure states. A public demo's inert control should not become a pretend LPC capability. Source-backed activity, files, messages, deadlines, and record navigation are a better translation than copying engineering issue labels or invented agent work.

Fresh LPC screenshots `linear-home-1440.png`, `linear-home-1920.png`, and `linear-record-detail-1440.png` under `docs/design-previews/paralegal-home/linear-desktop/` were also opened for independent visual review. Their 232 px rail and 40 px rows match the reference's density; the 630 px reading column and 286 px properties panel are clear. Two differences were sent to the implementation owner for consideration: the record screenshot adds a separate 44 px page header before its breadcrumb (placing the title about one toolbar lower than Linear), and the full 1920 px list creates a much larger title-to-action distance than the fixed 1320 px reference. These are observations of those captures, not assertions about later edits. No implementation or CSS was changed by this reference audit.
