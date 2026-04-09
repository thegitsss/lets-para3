# Founder Browser QA Checklist

Use this pass in a real browser on the current app build. The goal is to catch runtime breakage, stale states, misleading connected states, and broken cross-links before founder review.

## Preflight

- Verify the web app and the separate incident runner are both running.
- Confirm admin login works and the admin dashboard loads without console errors.
- Keep one signed-out browser window for public pages and one signed-in admin window for internal surfaces.
- If testing LinkedIn, use the deployed callback URL and a real LinkedIn app config. Do not test OAuth from a mismatched local callback.

## Public Homepage

- Load `/index.html` signed out.
- Confirm hero, nav, footer, and CTA links render without layout collapse on desktop and mobile widths.
- Click primary nav anchors and confirm they land on the correct sections.
- Confirm sign-in or apply/contact links do not 404.
- Watch for console errors, missing hero media, or dead CTA links.

## Attorney FAQ

- Load `/attorney-faq.html`.
- Confirm table of contents links scroll to the correct section.
- Confirm header links and sign-in state are truthful when signed out and signed in.
- Check mobile navigation and the “skip to main content” path.

## Paralegal FAQ

- Load `/paralegal-faq.html`.
- Confirm FAQ anchors work and no section is visually truncated.
- Confirm header nav links back to the homepage/contact flow correctly.
- Check mobile layout and keyboard tab order.

## Paralegal Admission Page

- Load `/paralegal-admission.html`.
- Confirm the requirements content reads cleanly and all internal anchors work.
- Verify any apply or sign-in CTAs resolve correctly.
- Check that no stale sample text or broken assets are visible.

## Help Surfaces

- Load `/help.html` and `/paralegalhelp.html`.
- Confirm the help forms render, required fields behave correctly, and submission states are truthful.
- Check that support email / fallback contact links are present.
- If submitting a real or staged help item, confirm the surface gives a clear success or failure message.

## Admin Dashboard / AI Control Room

- Load `/admin-dashboard.html` as admin.
- Confirm Overview cards populate from backend data and do not show placeholder counts.
- Open AI Control Room and click:
  - Founder
  - Admissions / Review
  - Lifecycle & Follow-Up
  - Support
  - Payments & Risk
  - Incidents
- Confirm each focus panel loads without stale or mixed copy that implies stronger certainty than the backend actually has.
- Check that partial failures degrade to a truthful “unavailable” or empty state instead of a broken panel.

## Knowledge Studio

- Open Knowledge Studio.
- Confirm counts, sources, latest items, and approvals load.
- Click at least one knowledge record and verify detail/revisions render.
- Trigger a refresh or sync only in a safe environment and verify the status message is truthful.
- Watch for blank detail panes, broken citation rendering, or stuck loading text.

## Marketing

- Open Marketing drafts and publishing loop.
- Confirm draft queue, packet detail, publishing settings, cycle list, and LinkedIn section all load without throwing.
- Create or open a packet and verify readiness/history blocks render truthfully.
- Confirm no publish action is enabled for non-approved packets.
- Confirm Facebook still reads as unavailable for publishing.

## Support

- Open Support workspace.
- Confirm overview counts, ticket list, FAQ candidates, and insights load.
- Click at least one ticket and confirm detail, recommended reply, citations, and incident links render.
- If no data exists, confirm the workspace shows a real empty state instead of a blank pane.

## Sales

- Open Sales workspace.
- Confirm counts, account list, packet list, account detail, and packet detail all load.
- Click one account and one packet.
- Verify packet action buttons are present only inside the account detail context and do not error on click in a safe environment.
- Confirm empty-state wording stays truthful if there are no accounts or packets.

## Incident Workspace

- Open Incident workspace from the admin dashboard.
- Confirm list, detail, timeline, and clusters all load.
- Click multiple incidents and verify the detail/timeline refreshes without stale carryover.
- Check that read-only states remain read-only and approval/deploy truth is visible when present.

## Approvals Workspace

- Open Approvals workspace.
- Confirm overview counts and filtered item list load.
- Apply at least one filter change and verify the list refreshes.
- Click a review item and confirm detail, citations, and action buttons render.
- Confirm read-only items do not pretend to be actionable.

## LinkedIn Connection Surface

- In Marketing, review the LinkedIn connection block before connecting.
- Confirm it starts in a truthful setup state:
  - `not_connected`
  - no fake org ID
  - no fake URN
  - no fake token expiry
  - no fake scopes
- Start OAuth only in the correct environment and confirm:
  - popup opens
  - callback returns to the admin window
  - connection state updates truthfully
  - org identity is shown only if actually discovered
- Validate authorization and confirm only `connected_validated` is treated as ready.

## Likely Breakpoints To Watch

- Admin workspace loaders partially succeeding and leaving stale detail panels behind.
- Signed-in versus signed-out header state drifting on public FAQ/help pages.
- War Room copy implying canonical truth where the backend is still using heuristics or compatibility-only lifecycle signals.
- Marketing publish readiness showing stale connection or packet state after refreshes.
- Incident detail and timeline panels not clearing when the selected incident changes or a fetch fails.

## Manual-Risk Areas Still Worth Extra Attention

- Public static pages do not have meaningful automated browser coverage.
- Admin workspace rendering across Marketing, Support, Sales, and Approvals is still mostly manual-browser tested rather than component-tested.
- LinkedIn OAuth and publish flows still require live environment testing with real provider configuration.
- Mobile layout and keyboard navigation remain primarily manual verification areas across public and admin surfaces.
