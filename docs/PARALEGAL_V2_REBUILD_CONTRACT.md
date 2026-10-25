# Paralegal V2 rebuild contract

Approved direction: Attorney and Paralegal are the same LPC product with different authorized work. Attorney V2 is the reference, not a redesign target.

## Rules
- Replace superseded Paralegal presentation instead of adding CSS correction layers.
- Preserve existing API boundaries, security, persisted records, permissions, drafts, and deep links.
- Share established components where possible; retain differences only for role-specific work.
- Preserve secondary capabilities through deliberate navigation placement.
- No production/Stripe credential or payment-data changes.
- No completion claim based only on unit tests or empty-account screens.

## Acceptance checklist
- [x] Shell: brand account menu, five primary destinations, nested Matters navigation, identical icon and focus conventions.
- [x] Styles: retire original shell and corrective overlays; one owner for each rebuilt surface.
- [x] Home: Attorney hierarchy and row patterns; accurate counts and direct destinations.
- [x] Matters: uniform row hierarchy, compact toolbar, automatic persistent filters, meaningful page size, arrow pagination, secondary action menus.
- [x] Find Work: same toolbar/filter/menu grammar; preserve eligibility and application authority.
- [x] Workspace: consistent navigation and task/file/message/deadline/financial presentation with role-specific actions.
- [x] Messages: retain shared Attorney conversation renderer and verify Paralegal behavior.
- [x] Payouts, Profile, Settings, Help: consistent headings, controls, menus and recovery states.
- [x] Populated synthetic workflows checked in Chromium and WebKit, including keyboard and narrow screens.
- [ ] Authenticated live inspection; record unavailable account states and environment failures explicitly.

Implementation progress and evidence must identify incomplete items. Do not interpret this checklist as permission to delete existing capabilities.

## September 30 implementation evidence

- Replaced the sidebar/profile-block composition with the brand account menu, five main destinations, and nested Matter navigation. Secondary tools and previous-workspace access remain available.
- Deleted `paralegal-original-shell.css`, `paralegal-consistency.css`, `paralegal-v2-parity.css`, and `paralegal-settings-refinement.css`. Retained rules were consolidated into component owners; common shell/dialog rules belong to the base stylesheet. The secondary Home tool renderer still uses `paralegal-original-workspace.css`; it was not removed or falsely described as retired.
- Rebuilt Active, Applications, Invitations and History presentation around a shared record hierarchy. Applications open through their titles. Inventories paginate at 20 records with arrow controls. Contextual actions retain their existing handlers and confirmation boundaries.
- Rebuilt Find Work rows and the 280px automatic filter menu. Filter preferences are scoped to the verified account. Listing titles retain full posting access and return focus; applications still use the canonical job/case endpoint.
- Normalized Matter headings, navigation, task/file sections, Settings heading/tabs and Help disclosures. Conversations retain the approved shared renderer. The rebuild does not create new payment, task-completion, or hiring authority.
- Fixed invitation expansion/read-position capture for the new disclosure structure, application-title focus restoration, and menu-trigger focus after confirmation. Muted text now passes contrast on row hover.

## Verification and limits

Evidence directory: `outputs/paralegal-rebuild-2026-09-30/`.

- `contracts.log`: 49/49 focused contract checks passed. Obsolete expectations for the retired shell sizes, saved-view controls, duplicate Details links and globally prohibited shadows were updated to the approved contract. Browser tests cover the interactions independently.
- `final-browser.log`: initial broader run passed 57/60; the three failures were invitation hover contrast, an outdated withdrawal-test step, and a WebKit Cancel-edit timeout. Contrast was corrected; withdrawal coverage now follows the actual dialog lifecycle. The unchanged Cancel-edit case passed on isolated rerun. This timeout remains recorded in the evidence, not erased.
- `followup-browser.log`: 5/6 passed; the additional WebKit return-focus failure led to an explicit focus-ownership correction.
- `webkit-recovery.log`: 2/2 passed after the focus correction, including Cancel edit.
- `closing-browser.log`: 12/12 passed across Chromium and WebKit on the changed workflow surfaces: populated Matter work/files, invitation acceptance and refresh, application withdrawal confirmation, Find Work submission, Settings autosave/security, and Help/Assistant navigation.
- `browse-browser.log`: both engines verified title-to-posting navigation, return focus and the canonical application target.
- Attorney preservation: `attorney-verification.json` compares 142 Attorney files with the start-of-turn baseline; zero changed.

Authenticated live screenshots cover Home, Applications, History, Find Work/filter menu, Messages, Payouts, Profile Settings and Help. The signed-in account contains eight applications and two historical Matters, with no active Matters, invitations, conversations or open listings. Populated workflow proof is synthetic and is not a substitute for the remaining real-account inspection.

Localhost repeatedly changed backend processes and returned connection-refused/interrupted-stream errors during inspection. Reads recovered between restarts. Stable live verification is pending confirmation that other backend-editing tasks have stopped, plus access to a populated test account if one exists. Stripe/F1 stays deferred. This is not a launch or whole-Paralegal completion certification.

Final scoped verification: 66 distinct browser checks have passing results across the final and targeted reruns. `workspace-tabs-final.log` adds passing Chromium/WebKit inspection of Activity, Deadlines and verified synthetic Financials to the existing workspace check. The first extension failed because its fixture omitted the protected deadline-review endpoint; only the fixture was corrected. No access check was bypassed. `frontend-manifest.json` records the verified frontend file hashes so subsequent work can compare changes instead of restarting this audit without cause.

The only unchecked item in this implementation checklist is stable authenticated live verification of the unavailable populated states. This does not close separate release gates, provider verification or the deferred Stripe/F1 issue.
