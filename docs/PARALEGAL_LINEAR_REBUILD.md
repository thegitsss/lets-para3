# Linear desktop rebuild

The first translation retained the stacked LPC dashboard and did not reproduce the requested interface. This revision replaces that composition with distinct desktop screens. [Side-by-side visual comparison](design-previews/paralegal-linear/redo/comparison.html).

The actual application entry is `http://localhost:5050/paralegal-v2.html#/home`. It requires the user's paralegal session. Screenshots use synthetic records in the isolated browser harness; those records are not inserted into the live database.

## Composition

Home fills the browser window. The rail stays 232px wide at the left edge, with 208 × 28px navigation rows and 2px gaps. Notifications, Assistant and profile controls stay at the top right. The main panel stretches to the right and bottom edges with an 8px inset, below the 48px global tools area. The sidebar edge handle collapses and restores the rail. Main headers and toolbars are each 44px. Mobile navigation retains the existing accessible drawer. This supersedes the earlier centered 1320 × 720 demo frame; the side-by-side reference comparison documents that earlier sizing.

| Linear public desktop | LPC screen |
| --- | --- |
| Initial issue detail | First authorized active matter; 662px article wrapper, 630px inner reading column, 286px properties column |
| Pulse | Separate Updates feed, 720px centered column, real updates and explicit existing actions |
| Inbox | 319px queue with selected record beside it; All/Unread filters |
| My issues | My work, 40px rows grouped under 36px status headers; compact IDs, status symbols, practice chips, attorney initials and due dates |
| Reviews | Review queue and a separate document surface; Overview/Activity/Files tabs over verified LPC record information |
| Initiatives | Matters table, 56px rows with aligned target, status, work-item, attorney and unread columns |
| Projects | Recorded deadline timeline with 108px row cadence, 160px months, a six-month window and three-month navigation |
| Agent tasks | Work board, 338px columns, 12px gaps and 96px cards |
| Agent Insights | Work insights, three 104px metric panels and two lower chart/table panels |
| UI Refresh | Matter overview document with inline properties, labels and resource links |
| Floating agent | Existing LPC Assistant in a 400 × 520px floating window on desktop |

Fonts remain Sarabun plus the existing LPC serif wordmark. Surfaces are white, text is navy, and cornflower marks controls/status symbols/chart values. No Linear logo or font was imported.

The navigation and controls operate on the current LPC application. Filtering, sorting, selection, previous/next, copied links, in-session favorites, tabs and board views are real local presentation operations. Search, notifications, profile tools, availability saves and Assistant drafts retain their existing owners. Full matter and payment actions still use existing authorized destinations.

## Data boundaries

The renderer consumes the existing pure Home model and introduces no API requests or record mutations. Selecting a Home detail does not fetch a confidential file, mark a message read, accept an invitation, apply, or change status. Expired/restricted access removes selected records and their sidebar projection. An empty account is displayed honestly.

LPC has no software-code diff or agent project duration in this Home projection. Reviews therefore show recorded legal-work information, and the timeline shows recorded dates. No legal document text, start dates, durations, AI completion, or history was invented to fill the reference. Favorites are transient for the current verified Home identity, without a new persistent store.

## Verification

All runs used isolated synthetic records and Node 24.18.0. Current evidence:

- [78/78 model and shell checks](design-previews/paralegal-linear/redo/model-shell.txt), five suites.
- [33/33 final browser cases](design-previews/paralegal-linear/redo/browser-33.txt), Chromium, Firefox and WebKit. This includes all ten compositions, exact desktop geometry, mobile navigation, filtering, board/detail navigation, copy, empty/failed sources, authorization loss, duplicate availability saves, distinct application IDs, account/search/Assistant controls, timeline/document controls, larger viewport and forced colors.
- Automated WCAG 2.2 AA checks passed in the tested detail, work, Inbox and insights states across all three browsers.
- The final focus-retention adjustment passed [9/9 targeted keyboard, filtering and Assistant checks](design-previews/paralegal-linear/redo/keyboard-assistant-9.txt) across all three browsers, including larger text. This is not a claim that the original historical Home suite or a production certification was rerun.

The initial Chromium run was 4/5 because its failure fixture supplied a boolean HTTP status; it was corrected to 503. The following 27-case run passed, followed by the expanded 33-case run above. [Initial raw result](design-previews/paralegal-linear/redo/initial-chromium.txt), [27-case result](design-previews/paralegal-linear/redo/browser-27.txt).

Screenshots named `chromium-`, `firefox-`, and `webkit-` in the [comparison](design-previews/paralegal-linear/redo/comparison.html) are captures of the implemented app. `*-geometry.json` records measured dimensions; [source hashes](design-previews/paralegal-linear/redo/source-sha256.json) identify the final files. No production records were seeded, and nothing was committed, pushed or deployed.
