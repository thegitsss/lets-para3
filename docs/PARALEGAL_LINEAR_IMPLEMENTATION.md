> Historical first translation, rejected for visual distance from the reference. Superseded by [the screen-by-screen rebuild](PARALEGAL_LINEAR_REBUILD.md). Its verification counts apply only to that earlier implementation.

# LPC desktop translation of Linear

The September 8 follow-up replaces the horizontal Paralegal V2 navigation and the previous Home composition with the desktop requested from Linear's public homepage. The working entry remains `frontend/paralegal-v2.html#/home`. No public marketing page, backend record, authorization rule, schema, or payment flow was replaced.

## Reference and sizing

The public interactive desktop was entered and its alternate views inspected directly. The [reference action matrix](PARALEGAL_LINEAR_REFERENCE.md) records tested controls, no-op demo controls, measurements, and screenshots. The original reference is [Linear's homepage](https://linear.app/).

LPC uses a persistent **232px sidebar**, **208 × 28px navigation rows**, **44px view bars**, **36px group headers**, **40px list rows**, and a **286px properties column** on wide desktops. The frame has an 8px inset. Record titles are 20px and operational text is 13px at LPC's default reading size. Rem ratios preserve larger saved reading preferences. Smaller screens use the existing mobile navigation drawer and reflow the properties column below the record.

The live application fills its viewport; the source marketing demonstration is a fixed 1320 × 720 frame. The component dimensions and reading column follow the measured desktop. A selected Inbox record retains its **319px queue** on wide screens and uses Back to list on smaller screens. Record detail has one 44px location bar and one 44px utility row, without a duplicate Home header.

The bundled Sarabun family supplies operational text; LPC's existing serif wordmark remains. The palette is white, navy `#0B2947`, and cornflower `#6495ED`. Navy text on cornflower has approximately 4.96:1 contrast; cornflower is not used for small text on white. Fine dividers use navy alpha over white. The selected filter is a cornflower pill.

The persistent shell and Home are white. Saved theme choices still apply to existing destination content such as Browse and Help; no stored theme preference was rewritten.

## Functions and ownership

| Linear desktop pattern | LPC implementation |
|---|---|
| Persistent left navigation | Home, Inbox, My matters, Applications, Browse Matters, Deadlines, History, current Matter shortcuts, account/help tools |
| Grouped issue list | Verified active work, invitations, applications and recommendations; local filtering, stable sorting and board presentation |
| Issue detail | Select a title to open the same verified record in place; Back, previous/next, copyable deep link, properties and current work-item progress |
| Inbox | Verified attention updates and unread conversations; selectable queue and adjacent detail; failed/loading/partial sources remain distinct; existing notification controls own notification mutations |
| Properties/activity | Recorded status, attorney, practice area, deadline and opportunity compensation; actual latest-update/file metadata only |
| Agent pane | Existing persistent LPC Assistant, including draft retention, keyboard access and its established permissions |
| Workspace menu/search | Existing profile/sign-out menu and real workspace search; sidebar collapse and mobile navigation reuse existing controllers |
| Favorites | Current assigned Matter shortcuts. No new persistent favorite store or invented saved records |
| Projects timeline | Deadline dates and private reminders from the existing authorized Home projection |

Full Files, Messages, Deadlines, Activity and Financials actions open the existing authorized Matter workspace. Paralegals cannot edit lifecycle status, assignment or payment state from a presentational property. Invitation acceptance and application submission remain in their existing workflows. The Home preview does not fetch full confidential Matter content or mark messages read.

## State integrity

The existing Home model, bounded concurrent reads, identity-scoped cache, session revision, timeout, stale-source handling, availability save boundary and cross-tab reconciliation are retained. Explicit navigation changes the requested view even if the previous filter had focus; background refresh still waits around active typing, dialogs and overlays. Initial deep links survive progressive loading. Previous/next follows the displayed filtered and sorted records. Access/session loss clears selected detail and current Matter shortcuts immediately, and late responses cannot restore them.

Selection, filters, timeline position and display mode are transient within the Home instance. No private record titles or new preferences are persisted in browser storage.

## Files and baseline

The pre-change Home renderer, controller, shell HTML and styles were saved in `/private/tmp/lpc-linear-20260908-baseline/`. The checkout already contained unrelated work and previous Home work; it was preserved.

The additions are `home-desktop.mjs`, the deadline timeline, `desktop-shell.mjs`, and the corresponding `paralegal-linear-*` styles. `home-view.mjs` integrates presentation while retaining its existing read/mutation boundaries. `app.mjs` passes Home query navigation and matches the selected sidebar view. `paralegal-v2.html` provides the persistent left rail.

This is local implementation and verification. It is not deployment, V1 retirement, or production activation.

## Verification and visual review

The existing isolated Playwright harness ran with synthetic identities and records at localhost, using Node 24.18.0. The Home/model/shell contracts passed **78/78 tests in five suites**; the [raw model/shell result](design-previews/paralegal-home/linear-desktop/model-shell-regressions.txt) is retained.

The **90-case Home + desktop matrix** completed **88/90** across Chromium, Firefox and WebKit. All 66 Home cases passed. Two WebKit desktop assertions incorrectly counted cancelled navigation requests as page reloads. The corrected tests verify one successful document response and the same document/sidebar objects; the final targeted matrix passed **12/12** across all three engines, also checking the retained Inbox queue. The existing Home, Foundation and global-tools workflows passed **36/36 in Chromium**.

After the final geometry adjustments, Inbox checks passed **3/3** and Board checks passed **3/3** across the three browsers. The first Board geometry assertion omitted the valid placement of a control above its title; visual inspection confirmed no overlap, and the corrected assertion passed. The [verification index](design-previews/paralegal-home/linear-desktop/verification-index.md) preserves the full run history, final logs, screenshots and verified source hashes. No failures remain unresolved from these checks.

The five Home widths—320, 375, 768, 1440 and 1920—produced **15 computed-style samples** across the three browsers: no document or workspace overflow, loaded Sarabun fonts, approved colors, and minimum measured text contrast **4.966:1**. Automated WCAG 2.2 AA checks passed for the tested Home/detail/Assistant states. Larger reading size, reduced motion, forced colors, keyboard navigation, modal focus, access loss, late responses and duplicate availability saves are covered. This is not a manual screen-reader or production certification.

Rendered review corrected inherited 44px sidebar rows, the stray old active marker, default-font scaling, overly tall work rows, the duplicate record header, narrow-screen property wrapping, the Inbox queue composition, stretching board columns, and the Inbox divider height. Board columns are 338px with 12px gaps and cards start at 96px, growing only as their content requires.

Current screenshots use browser prefixes under `docs/design-previews/paralegal-home/linear-desktop/`; the unprefixed `initial-*` captures are intermediate evidence.

- [Home desktop](design-previews/paralegal-home/linear-desktop/chromium-linear-home-1440.png)
- [Matter detail](design-previews/paralegal-home/linear-desktop/chromium-linear-record-detail-1440.png)
- [Inbox with selected record](design-previews/paralegal-home/linear-desktop/chromium-linear-inbox-detail-1440.png)
- [Board](design-previews/paralegal-home/linear-desktop/chromium-linear-board-1440.png)
- [Deadline timeline](design-previews/paralegal-home/linear-desktop/chromium-linear-deadline-timeline-1440.png)
- [Record detail at 320px](design-previews/paralegal-home/linear-desktop/chromium-linear-record-detail-320.png)
