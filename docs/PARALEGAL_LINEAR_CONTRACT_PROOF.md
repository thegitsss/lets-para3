# Paralegal V2 — implementation and evidence

September 8, 2026. Changes continue the existing Paralegal V2 application and its authenticated routes. Screenshots and the walkthrough use isolated synthetic accounts and intercepted API responses. They show the running frontend, not generated mockups. No production deployment, financial operation, external communication, or real-account mutation was performed.

## Reference map and visual comparison

The official My Issues, Inbox, UI refresh, header-system, sidebar-control and Peek images were downloaded, retained and visually inspected before changing the composition. The measurements below are the user's LPC targets, not measurements attributed to Linear.

| LPC screen or behavior | Official reference inspected | Retained image | Comparison with rendered LPC |
| --- | --- | --- | --- |
| My work | [My Issues](https://linear.app/docs/my-issues) | [Product screenshot](design-sources/linear-contract-20260908/my-issues.png) | Grouped compact records, restrained view tabs, aligned metadata and status icons. LPC uses Assigned / Invitations / Applications / Recommended and actual paralegal responsibilities. The initial list fills its available width. |
| Inbox | [Inbox](https://linear.app/docs/inbox) | [Product screenshot](design-sources/linear-contract-20260908/inbox.png) | A compact notification list with identity, event, time and unread state; a stable selected record and useful adjacent context. LPC uses a 352px list. Scope and files have different content; messages use the existing conversation destination. |
| Current application header and controls | [UI refresh](https://linear.app/changelog/2026-03-12-ui-refresh), [design explanation](https://linear.app/now/behind-the-latest-design-refresh) | [Refresh](design-sources/linear-contract-20260908/ui-refresh.png), [header system](design-sources/linear-contract-20260908/header-system.png), [sidebar controls](design-sources/linear-contract-20260908/sidebar-controls.png) | Persistent navigation, compact view header, separate subview toolbar, consistent small controls and restrained boundaries. LPC retains its existing top-right notifications, Assistant and account controls, sidebar search, availability owner and collapse grip. |
| Selected work, invitation and application | [Peek](https://linear.app/docs/peek) | [Product screenshot](design-sources/linear-contract-20260908/peek.png) | Selection preserves the originating list, filter, focus and scroll. LPC's explicit click target opens a 480px nonmodal pane; compact screens use a dedicated detail view and visible Back control. This is the brief's deliberate departure from Linear's floating Peek. |
| Reviews | [Diffs](https://linear.app/docs/diffs) | Documentation inspected; a Diffs product image was not retained or verified | Uses the existing submission/file lifecycle to separate Needs your action, Awaiting attorney and History. No code-review actions or new approval permissions were imported. The list/detail control structure follows the inspected Inbox and current application references. |
| Updates | [Inbox](https://linear.app/docs/inbox) | Same inspected Inbox reference | Uses recorded notifications, grouped by their actual New York event date, and the same selected-content renderer. No historical events are inferred from a current Matter status. |
| Public product demonstration | [Linear homepage](https://linear.app/) | [Earlier same-session capture](design-previews/paralegal-linear/reference/01-inbox.png) | Supplemental product list/detail reference retained earlier in this session; not represented as a fresh authenticated-workspace inspection. |

No private authenticated Linear tenant was available or accessed. Official product screenshots provided the required visual references. The design-explanation page timed out through the web text tool, but its HTML and official images were retrieved directly and the retained images were inspected. Diffs' image limitation does not affect the three required visual references above.

[Side-by-side comparison](design-previews/paralegal-contract/reference-comparison.html) links the exact retained references with the current rendered LPC screens. Final inspection corrected inherited event-row clipping, a 49px header, clipped enlarged text, inline invitation duplication, mobile action targets and the cold-load default text size. Long-title fixtures retain their complete text.

## Exact tokens and geometry

| Property | Implementation |
| --- | --- |
| Surfaces | `#FFFFFF` |
| Navy | Existing `--desktop-ink: #0b2947` |
| Cornflower | Existing `--desktop-blue: #6495ed`; `--v2-blue` uses the same value |
| Separators | Existing `--desktop-rule: rgba(11, 41, 71, .18)`; no new opacity palette |
| Working font | Existing `--v2-font-sans: "Sarabun", sans-serif`; locally loaded font faces verified |
| Wordmark | Existing approved Cormorant Garamond role retained |
| Expanded / collapsed navigation | 224px / existing 56px collapse rail |
| Main view header / subview toolbar | 48px / 44px at 1440px and normal text size |
| Horizontal working inset | 24px desktop, 16px compact layout |
| Navigation / standard icon / icon button | At least 36px / 16px / at least 32px desktop |
| Work row / group heading | At least 40px / 32px; compact two-line rows at least 56px |
| Selected My work pane / Inbox list | 480px / 352px desktop |
| Type | View title 16px/600; group 13px/600; record 14px/20px; metadata 12–13px; detail title 20px/28px/600; body 14px/22px |
| Selection / focus | White surface, cornflower outline plus navy leading indicator; separate dashed navy keyboard focus |
| Compact behavior | Dedicated detail at 1100px and below; existing navigation menu, horizontally scrolling tabs and at least 44px essential touch controls at 900px and below |
| Text enlargement | Font sizes and line heights scale together; fixed desktop heights expand when text requires it |

Calculated sRGB contrast: navy/white **14.76:1**, cornflower/white **2.97:1**, navy/cornflower **4.97:1**. Navy provides text, primary button contrast and the required selection/focus indicator. Cornflower is not the sole required contrast cue. Computed surfaces and colors, loaded Sarabun, 200% text, reduced motion and forced colors are checked in browser coverage.

## One presentation model and existing authorities

`home-workspace-model.mjs` projects the canonical `home-model.mjs` sources once. It does not create records or lifecycle states.

| Record | Source → permission / visibility | Ordering and responsibility | Action → confirmation → affected views |
| --- | --- | --- | --- |
| Assigned Matter | Existing dashboard, matching authenticated profile and assigned paralegal; explicit current, unarchived, unreleased, funded evidence for protected context | Actual unresolved revision or unresolved overdue commitment; otherwise active work. Waiting requires a real pending-review submission and completed recorded tasks. Each Matter appears once. | Selected scope reads existing `/api/cases/:id` only after selection. Full-workspace links retain the existing destination. Confirmed file/lifecycle events reconcile My work and Reviews. |
| Invitation | Existing `/api/cases/invited-to`; unresolved invitation for this account | Existing unresolved decision; visible tab/sidebar counts even while Assigned is selected | Existing `work-view` readiness, acceptance and decline handlers. Original confirmation rules and CSRF remain. Refetch invitation/application/recommendation sources after the server outcome; acceptance never creates assigned or funded work locally. |
| Application | Existing `/api/applications/my`; owning account, active application and permitted pre-engagement request | Recorded status, request and event time. Requested information has a concise tab/sidebar indicator | Existing pre-engagement form, retained draft store and withdrawal confirmation/mutation. Available `statusHistory` is rendered from actual dated entries. Confirmed changes refresh counts and exclusions; no fabricated review timeline. |
| Review | Existing `/api/uploads/case/:id?presentation=matter`; fetched only for verified current funded assignments, with server participant and assignment-file visibility checks | Paralegal-uploaded files only. Unresolved `attorney_revision` → action; `pending_review` → attorney; approved/resolved → History. Exact revision-request cycle and replacement evidence prevent duplicate obligations. | Exact existing file/revision destination; shared authorized preview/download helpers. No attorney approval controls. Actual broadcast refresh updates review categories, My work groups and counts. |
| Scope/file update | Existing user-scoped `/api/notifications`; server availability and authorized current Matter/file sources | Actual event timestamps; no inference from generic current state | Current authorized scope, or direct existing scope destination when context cannot be supplied. Exact file ID, metadata and authorized download/preview. Missing/deleted/restricted files remain explicit. Notification reads use the existing notification controller. |
| Message | Existing notification's authorized conversation/message destination | Unread remains unread, not a response obligation | Exact existing message link, composer and read contract. No second messaging system. |

Within each presentation group: applicable due date ascending, recorded event time descending, canonical record identifier as a deterministic tie-break. The dashboard projection has no authoritative explicit priority or human-facing reference field, so none is invented. Display groups are not persisted statuses.

Background refresh retains a chosen tab and defers replacement during focus, pointer interaction or editing. Context requests use abort/version/session guards. Account switch, logout and access loss clear selected content, cached history, confidential favorites and contextual counts. Failed reads are distinct from empty queues, including failed obligations in a different My work tab. Rejected per-Matter submission reads remain incomplete even after the protected Matter is removed; they cannot become a verified empty Reviews queue.

## Files changed for this contract

Production frontend:

- `frontend/paralegal-v2.html` — final contract stylesheet and entry cache revision.
- `frontend/assets/styles/paralegal-linear-shell.css` — required 224px persistent navigation geometry.
- `frontend/assets/styles/paralegal-workspace-contract.css` — fixed geometry, type, selection, responsive detail and white surfaces.
- `frontend/assets/scripts/paralegal-v2/first-paint.js` — applies the existing 17px default before a cold load, while honoring saved reading sizes.
- `frontend/assets/scripts/paralegal-v2/router.mjs` — default entry and My work title, retaining explicit destinations.
- `frontend/assets/scripts/paralegal-v2/app.mjs` — connects existing Work and notification owners to context rendering.
- `frontend/assets/scripts/paralegal-v2/home-model.mjs` — validated notification/submission sources and protected-source filtering.
- `frontend/assets/scripts/paralegal-v2/home-workspace-model.mjs` — shared deterministic presentation projection.
- `frontend/assets/scripts/paralegal-v2/home-view.mjs` — permission-bounded reads, refresh continuity and request disposal.
- `frontend/assets/scripts/paralegal-v2/home-desktop.mjs` — delegates the specified views and removes invented Matter references.
- `frontend/assets/scripts/paralegal-v2/home-workspace-view.mjs` — grouped work, event lists and selected actual context.
- `frontend/assets/scripts/paralegal-v2/work-view.mjs` — embeds the existing invitation/application handlers and drafts; exposes recorded application history.
- `frontend/assets/scripts/paralegal-v2/notifications-controller.mjs` — reuses confirmed notification read behavior without forcing navigation.
- `frontend/assets/scripts/paralegal-v2/matter-files.mjs` — exports existing file preview/link/download helpers for reuse; their behavior is unchanged.

Verification and retained evidence:

- `backend/tests/paralegalHomeWorkspaceModel.test.js`.
- `backend/tests/paralegalV2HomeContract.test.js` — reflects the required final stylesheet and permission-gated lazy scope access.
- `backend/tests/playwright/paralegal-support/linear-contract.spec.js`.
- `backend/tests/playwright/paralegal-support/linear-rebuild.spec.js` — preserves shell/destination tests with the new contract's explicit geometry and selected-detail behavior.
- `backend/tests/playwright/paralegal-support/v2-submissions.spec.js` — verifies review reconciliation using consistent synthetic identities and the current dashboard/file contracts.
- `docs/design-sources/linear-contract-20260908/`, `docs/design-previews/paralegal-contract/`, this document and `frontend/previews/lpc-contract/`.

Existing unrelated working-tree changes were retained. There are no backend route, schema, authorization, billing or financial-rule changes in this implementation.

## Verification results

Tests used the existing isolated Playwright harness and Node 24.18.0. No skips were added and the whole repository suite was not claimed.

| Run | Actual result and evidence |
| --- | --- |
| Targeted Jest models and contracts | **7 suites, 83 passed**; [log](design-previews/paralegal-contract/evidence/final-jest-contracts.txt). |
| Final Chromium contract, persistent-shell and review synchronization run | **26 passed**; [log](design-previews/paralegal-contract/evidence/chromium-contract-and-shell.txt). |
| Existing invitation, application, submission and message owners | **13 passed**; [log](design-previews/paralegal-contract/evidence/existing-workflow-owners.txt). Includes payout-readiness failure, draft recovery, confirmation, duplicate prevention, revision linkage, send retries and authorization loss. |
| Initial complete three-browser contract/review matrix | **38 passed, 1 failed**; [unaltered log](design-previews/paralegal-contract/evidence/initial-three-browser-matrix.txt). Firefox serialized the font family with optional quotes. The assertion now normalizes those quotes while still requiring the exact family and a loaded Sarabun face. |
| Three-browser follow-up | **9 passed**; [log](design-previews/paralegal-contract/evidence/three-browser-followup.txt). Includes the corrected font assertion, confirmed inline pre-engagement responses/drafts and recommended-listing identity. |
| Final cold-load type, responsive targets and desktop/mobile scroll restoration | **6 passed** across Chromium, Firefox and WebKit; [log](design-previews/paralegal-contract/evidence/final-type-and-scroll.txt). The actual cold-load measurements are root 17px, view title 16px, record text 14px; both Sarabun and Cormorant Garamond loaded: [measurements](design-previews/paralegal-contract/evidence/computed-type.json). |
| Final nested submission-access failure checks | **9 passed** across Chromium, Firefox and WebKit; [log](design-previews/paralegal-contract/evidence/final-submission-access.txt). Tests require an explicit error and incomplete counts after revoked per-Matter reads, never a verified empty review queue. |
| Syntax and file integrity | [Syntax checks](design-previews/paralegal-contract/evidence/syntax-checks.json), [changed-source hashes](design-previews/paralegal-contract/evidence/changed-source-manifest.json). Scoped whitespace check passed. |

Across the final results, 67 distinct browser cases have passing coverage: 12 contract scenarios and two review synchronization scenarios in each of three browsers, plus 12 persistent-shell and 13 existing-handler cases in Chromium. Repeated focused checks are not counted as additional distinct scenarios.

Earlier implementation failures were corrected: stale visual baselines, inherited clipping, mobile inline-link targets, nested rejected submission sources, and cross-tab fixtures with mismatched identities/missing authoritative assignment fields. Required assertions reflect the user's new geometry and behavior. Permission checks remain strict.

## Preview artifacts

[Shareable gallery](https://software-useful-kodak-repeated.trycloudflare.com/previews/lpc-contract/) · [download video](https://software-useful-kodak-repeated.trycloudflare.com/previews/lpc-contract/lpc-contract-walkthrough.webm) · [download preview package](https://software-useful-kodak-repeated.trycloudflare.com/previews/lpc-contract/lpc-contract-preview.zip).

The approximately one-minute 1440×1000 WebM shows the actual frontend and synthetic outcomes: invitation acceptance removes the invitation without adding assigned work; confirmed withdrawal removes the application; actual event context marks notifications read; a simulated authoritative approval clears revision responsibility and updates History/My work. The approval is an incoming simulated server change, not an attorney control exposed to a paralegal.

The gallery contains 34 screenshots and a 60.56-second video. Public playback and chapter navigation returned HTTP 200 with no browser errors, without an authenticated account: [public check](design-previews/paralegal-contract/evidence/public-preview-final.json). The ZIP passed its integrity check: [artifact verification](design-previews/paralegal-contract/evidence/artifact-verification.json). Its chapter script uses the existing Content Security Policy's permitted external-script path; no security policy was relaxed. The authenticated application remains at the [existing application link](https://software-useful-kodak-repeated.trycloudflare.com/paralegal-v2.html#/home?view=work).

## Genuine contract limits

1. **Closed-Matter review aggregation:** the existing uploads listing requires a funded, usable current workspace and rejects closed Matters. Reviews History therefore displays resolved submission records from authorized current Matters and says so. The existing Completed matters destination remains accessible. A complete cross-Matter closed-submission archive needs an authorized historical listing contract; this requirement is not claimed complete.
2. **Historical scope differences:** selected events show the current authorized scope. The current context APIs do not supply versioned before/after scope evidence. No diff or historical scope version is fabricated.
3. **Event window:** the notification endpoint returns at most 100 records without pagination. Inbox/Updates use that actual window and label the bound when reached. They are not a complete historical audit log.
4. **Missing reference / priority data:** current dashboard records do not supply a human-facing Matter reference or explicit priority. Those fields are omitted; due date, actual recorded time and canonical ID provide deterministic ordering.
5. **Submission aggregation cost:** no existing cross-Matter submission index is available. File metadata reads are limited to verified funded assignments and at most four concurrent requests. A slow/failed source is shown as incomplete, not as zero obligations. Large-account performance beyond the synthetic long-list test is not certified.
6. **Release scope:** this is local implementation and isolated verification, not production-release certification. No real test-account password is needed for the static preview gallery; the authenticated application retains its normal login. The approved Cloudflare link is temporary and depends on this computer and tunnel continuing to run.
