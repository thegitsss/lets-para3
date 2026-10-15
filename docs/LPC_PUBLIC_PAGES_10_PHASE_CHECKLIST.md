# LPC Public Pages: 10-Phase Visual Consistency Checklist

Status: Phases 1–10 execution and verification complete; final user visual approval remains required before deployment. Every phase required an explicit user prompt to proceed. This checklist authorizes visual and public-page UX work only. It does not authorize backend, authentication, account-review, email-delivery, payment, database, API-contract, deployment, or production-data changes.

Audit date: 2026-08-28  
Workspace: `lets-para3`  
Audit evidence: `test-results/public-visual-audit-20260828/`

## Operating rules

- [x] Begin a phase only after the user explicitly says to proceed with that phase.
- [x] Change only the phase currently authorized by the user.
- [x] Preserve backend logic, route authorization, API calls, account-review behavior, email verification behavior, and data contracts.
- [x] Preserve unrelated user changes in the working tree.
- [x] Do not silently expand a phase into authenticated product redesign work.
- [x] Do not deploy, commit, push, or change external services unless separately requested.
- [x] At the start of each phase, record the exact files expected to change.
- [x] At the end of each phase, run its focused checks and report remaining items before marking it complete.
- [x] Test visual changes at 320x844, 390x844, 768x1024, 1366x900, and 1920x1080 unless a phase specifies additional coverage.
- [x] Check keyboard access, visible focus, reduced motion, horizontal overflow, and touch-target sizing for every modified interactive component.
- [x] Keep an issue unchecked if it is only partially fixed or lacks browser verification.
- [x] Reopen an item if a later phase creates a regression.

## Public-surface inventory

The remediation scope contains the following 17 anonymous/public surfaces:

- [x] `/index.html`
- [x] `/login.html`
- [x] `/signup.html`
- [x] `/browse-paralegals.html`
- [x] `/forgot-password.html`
- [x] `/reset-password.html`
- [x] `/verify-email.html`
- [x] `/privacy.html`
- [x] `/terms.html`
- [x] `/accessibility.html`
- [x] `/contact.html`
- [x] `/paralegal-admission.html`
- [x] `/attorney-faq.html`
- [x] `/paralegal-faq.html`
- [x] `/help.html`
- [x] `/paralegalhelp.html`
- [x] Branded 404/unknown-route response

Nineteen additional frontend documents are protected product routes. Their anonymous redirect behavior is a regression boundary, not a visual-remediation target.

## Phase status

| Phase | Scope | Status |
|---|---|---|
| 1 | Public directory corruption and account-menu leakage | Complete — 2026-08-28 |
| 2 | Directory sort and filter controls | Complete — 2026-08-28 |
| 3 | Directory responsive cards, prompts, and touch targets | Complete — 2026-08-28 |
| 4 | Homepage overflow, parallax geometry, and pacing safeguards | Complete — 2026-08-28 |
| 5 | Attorney and paralegal public help pages | Complete — 2026-08-28 |
| 6 | Legal, FAQ, admission, contact, and utility-page consistency | Complete — 2026-08-28 |
| 7 | Authentication, recovery, verification, and application states | Complete — 2026-08-28 |
| 8 | Shared public design-system consistency | Complete — 2026-08-28 |
| 9 | Accessibility, navigation integrity, copy truthfulness, and semantic cleanup | Complete — 2026-08-28 |
| 10 | Complete responsive regression, interaction verification, and certification | Verification complete — 2026-08-28; user visual approval pending |

---

## Phase 1 — Remove public-directory corruption

Goal: ensure the signed-out Browse Paralegals page ends cleanly at the public footer and never exposes authenticated account-menu UI.

### Implementation checklist

- [x] Identify why `assets/scripts/sidebar-profile.js` injects `.profile-dropdown.lpc-sidebar-account-menu` on the public directory.
- [x] Prevent the authenticated/sidebar account menu from being created for an anonymous public-directory visitor.
- [x] Ensure no giant avatar, raw SVG icon, Settings link, Member label, profile link, or Sign out button appears after the public footer.
- [x] Ensure the fix does not remove the account menu from authenticated product surfaces that legitimately use it.
- [x] Remove any public-page CSS dependency on authenticated-sidebar menu styling.
- [x] Confirm no hidden focusable controls remain after the footer.
- [x] Confirm no `aria-hidden="true"` container contains focusable account-menu descendants.
- [x] Confirm Browse page height ends at the real footer rather than extending thousands of pixels.
- [x] Confirm the footer remains visually and functionally intact.

### Verification checklist

- [x] Signed-out Browse has no account-menu DOM after the footer at all five target viewports.
- [x] The page can be traversed by keyboard without reaching invisible post-footer controls.
- [x] The previous `aria-hidden-focus` accessibility violation is gone.
- [x] Browse desktop no longer reaches approximately 7,500px solely because of injected menu content.
- [x] Browse mobile no longer gains approximately 1,521px of rogue post-footer content.
- [x] Authenticated sidebar/account-menu behavior is regression-tested without changing its logic.

### Phase 1 completion evidence

- Root cause: the shared profile script executed before the public directory’s asynchronous session check, found the dormant authenticated sidebar, created a fallback Member menu, and portaled it to `document.body` for signed-out visitors.
- Remediation: the directory no longer loads the sidebar profile script statically. It imports that script only after `hydrateViewer()` confirms a real signed-in user; other authenticated product pages retain their existing script path and logic.
- Browser regression: `public-directory-account-menu.spec.js` passed 6/6 journeys in Chromium, Firefox, and WebKit. The signed-out journey checks 320x844, 390x844, 768x1024, 1366x900, and 1920x1080; the authenticated journey confirms the legitimate menu DOM and toggle behavior remain.
- Accessibility regression: the focused signed-out Browse WCAG A/AA test passed 3/3 in Chromium, Firefox, and WebKit.
- Syntax and diff hygiene: `node --check` passed for the modified application script and the new regression spec; the scoped `git diff --check` passed.
- Known unrelated repository gates remain assigned to later phases: frontend hygiene reports the three broken Admission hashes assigned to Phase 6; frontend binding checks report pre-existing unrelated bindings in `attorney-tabs.js`, `public-site-chrome.js`, and `utils/session.js`.

---

## Phase 2 — Repair directory sorting and filtering

Goal: provide one branded, correctly positioned, fully operable sort/filter system on mobile and desktop.

### Sort-control checklist

- [x] Move shared `.sort-native`, `.sort-menu-control`, `.sort-menu-trigger`, and `.sort-menu-options` rules out of the mobile-only media query.
- [x] Render exactly one visually apparent sort control at every viewport.
- [x] Properly visually hide the native select while retaining its intended form/accessibility role, if the native control is still required.
- [x] Remove the raw default-browser button appearance on desktop.
- [x] Remove the raw bulleted option list on desktop.
- [x] Anchor the custom option menu directly beneath the trigger.
- [x] Keep the menu within the viewport at 320px and 390px.
- [x] Match menu width to the trigger or establish a deliberate, consistent width.
- [x] Use the intended options and ordering: Newest first, Most experience, and Name A–Z.
- [x] Preserve the existing sort values and result-ordering logic.
- [x] Ensure the selected option is visually and semantically communicated.
- [x] Support mouse, touch, Enter, Space, Escape, Arrow Up, and Arrow Down behavior as appropriate.
- [x] Return focus to the trigger when the menu closes by keyboard.

### Filter-control checklist

- [x] Keep the Apply button navy and prevent reintroduction of purple.
- [x] Make Experience, Specialty, and State menu widths align with their fields.
- [x] Prevent Specialty and State lists from extending over Reset, Apply, other fields, or result cards.
- [x] Add an intentional maximum height and internal scrolling for long option sets.
- [x] Ensure all 42 Specialty choices are reachable.
- [x] Ensure all 51 State choices are reachable.
- [x] Correct stacking so an open list cannot intercept clicks intended for another closed field.
- [x] Close an open list when another filter is opened.
- [x] Close menus on outside click and Escape.
- [x] Keep the filter panel inside the viewport at 320px.
- [x] Preserve Reset and Apply behavior and the existing filter query logic.
- [x] Confirm filter labels, selected values, and expanded/collapsed state are correctly exposed to assistive technology.

### Verification checklist

- [x] Desktop Sort by no longer shows the native select and custom control simultaneously.
- [x] No sort option is rendered as a raw list item.
- [x] Sort values change correctly at all five viewports.
- [x] All filter menus remain inside the panel or intentionally overlay it without obscuring actions.
- [x] State remains clickable after Specialty has been opened.
- [x] Reset clears visible selections and underlying filter values.
- [x] Apply uses current selections and closes the panel as intended.
- [x] Sort/filter controls pass keyboard, focus, overflow, and accessibility checks.

### Phase 2 completion evidence

- Root causes: the entire branded sort-control block was nested inside `@media (max-width: 960px)`, while Specialty and State were forced into 224px absolute overlays beneath 304px fields.
- Sort remediation: the custom listbox is shared across all viewports, the underlying state select is fully hidden, options are direct branded listbox choices rather than raw list items, and selection remains synchronized with the existing `recent`, `experience`, and `alpha` values.
- Filter remediation: Specialty and State are full-width in-flow listboxes with 180px internal scrolling. They expand within the constrained panel instead of covering fields or actions; opening either closes the other.
- Accessibility: both filter triggers expose combobox/listbox relationships, selected counts, expanded state, multiselect semantics, roving option focus, visible focus treatment, and keyboard selection. Escape restores trigger focus for submenus and the sort menu.
- Cross-browser regression: `public-directory-sort-filter.spec.js` passed 12/12 journeys in Chromium, Firefox, and WebKit, including all five required viewport sizes and real touch-enabled 390x844 browser contexts.
- Regression boundaries: the completed Phase 1 suite remained green at 6/6, and the focused Browse WCAG A/AA test remained green at 3/3 across Chromium, Firefox, and WebKit.
- Static verification: syntax and scoped diff checks passed. Repository-wide frontend checks report only the previously documented Admission hash failures and unrelated pre-existing binding findings assigned to later work.

---

## Phase 3 — Correct directory responsive layout and public prompts

Goal: make the public directory comfortable and truthful from 320px through wide desktop without changing profile, inquiry, or authentication logic.

### Responsive-layout checklist

- [x] Resolve the pre-existing signed-in directory shell overlap in which public header/footer chrome can remain visually present over the authenticated sidebar.
- [x] Confirm the signed-in sidebar profile trigger receives a real pointer click without public-shell content intercepting it.
- [x] Keep the filter panel fully within a 320px viewport; remove the approximately 11px left clipping.
- [x] Keep the signed-out prompt fully within a 320px viewport; remove its approximately 16px clipping on each side.
- [x] Replace fixed or minimum widths that produce a 352px prompt inside a 320px viewport.
- [x] Review profile-card behavior below approximately 360px.
- [x] Prevent the 150px portrait from leaving an unusably narrow text column.
- [x] Stack or resize image/text content at compact widths while preserving the 390px and desktop composition.
- [x] Ensure names, specialties, chips, rates, and actions wrap deliberately.
- [x] Confirm cards do not depend on body clipping to conceal overflow.
- [x] Preserve portrait aspect ratios and fallback-image behavior.

### Prompt and action checklist

- [x] Correct the signed-out copy so it does not claim that sign-in is required to filter.
- [x] Clearly distinguish actions that truly require sign-in: opening restricted profiles or sending inquiries.
- [x] Replace the gold/brown Sign In primary treatment with the established public primary-action treatment.
- [x] Normalize “Sign In,” “Sign in,” “Create Account,” and “Create an account” wording according to the site-wide copy standard established in Phase 8.
- [x] Keep prompt focus management and dismissal behavior intact.
- [x] Keep the filter icon large enough for a comfortable touch target.
- [x] Increase Previous and Next pagination targets from approximately 31px to the public mobile target standard.
- [x] Preserve current pagination logic and disabled states.

### Verification checklist

- [x] No directory component is clipped or horizontally scrollable at 320px.
- [x] The 320px card layout remains readable with long names and multiple chips.
- [x] The signed-out prompt accurately describes available and restricted actions.
- [x] All prompt, filter, pagination, and close controls meet the selected touch-target standard.
- [x] Directory loading, populated, empty, error, fallback-photo, and account-required states remain functional.

### Phase 3 completion evidence

- Files changed for this phase: `frontend/browse-paralegals.html`, `frontend/assets/scripts/browse-paralegals.js`, `backend/tests/playwright/accessibility/public-directory-responsive.spec.js`, and this checklist. No backend, authentication, profile, inquiry, or API logic was changed.
- Signed-in shell remediation: the directory now hides the generated public header and footer with signed-in-specific selectors strong enough to override shared public-chrome display rules, removes the public header offset, and synchronizes the generated header’s `hidden` state. A real pointer click now opens the authenticated sidebar profile menu.
- Compact responsive remediation: the account prompt uses border-box sizing, compact cards stack the portrait above a full-width text column below 360px, the existing 150px composition remains at 390px, long content wraps within the card, and image borders no longer expand the declared portrait geometry.
- Prompt remediation: the copy explicitly says browsing and filtering are available signed out and limits sign-in requirements to full profiles and inquiries. The actions now read “Sign in” and “Create an account,” and the primary action uses the established navy treatment.
- Touch targets: the filter trigger, filter close control, compact filter fields/options/actions, profile actions, prompt actions, and Previous/Next pagination controls meet a 44px minimum target while retaining their existing behavior and disabled states.
- Phase 3 browser regression: `public-directory-responsive.spec.js` passed 12/12 journeys in Chromium, Firefox, and WebKit across 320x844, 390x844, 768x1024, 1366x900, and 1920x1080. Coverage includes long populated cards, loading, empty, error, fallback-photo, account-required, pagination, signed-in shell, pointer interaction, focus restoration, touch targets, and horizontal-overflow checks.
- Prior-phase regression: Phase 1 and Phase 2 directory suites remained green at 18/18 across the browser matrix. The focused Browse WCAG A/AA suite remained green at 3/3.
- Static verification: JavaScript syntax and scoped diff checks passed.

---

## Phase 4 — Stabilize homepage parallax and responsive pacing

Goal: preserve the approved cinematic homepage while eliminating desktop overflow and preventing unintentional responsive gaps.

### Defect checklist

- [x] Identify every transformed Attorney Assistant/parallax descendant extending beyond the desktop viewport.
- [x] Eliminate the approximately 198px overflow at 1366px.
- [x] Eliminate the approximately 275px overflow at 1920px.
- [x] Prevent preview header, messages, suggestions, composer, and disclaimer from expanding document `scrollWidth`.
- [x] Keep intended visual motion without clipping assistant content.
- [x] Confirm no horizontal scroll is possible at any target viewport.
- [x] Confirm overflow containment does not crop focus rings, shadows, or intentional animation.

### Pacing and safeguard checklist

- [x] Preserve the user-approved constellation treatment, cornflower-blue color, and current section ownership.
- [x] Preserve the current Attorney Assistant content parity between mobile and desktop.
- [x] Preserve the removal of parallax from Answers Before You Get Started.
- [x] Preserve parallax where explicitly approved, including the role-entry section.
- [x] Review the approximately 3,814px mobile workflow section for accidental blank intervals.
- [x] Review the approximately 2,202px mobile role-path section for accidental blank intervals.
- [x] Review the approximately 2,467px mobile clarity/assistant section for accidental blank intervals.
- [x] Distinguish intentional cinematic dwell time from empty space caused by fixed heights or transforms.
- [x] If spacing is adjusted, keep balanced top and bottom padding around Two Perspectives.
- [x] Do not reintroduce the previously rejected constellation eyebrow beneath the header.
- [x] Respect `prefers-reduced-motion` without losing content or producing empty reserved space.

### Verification checklist

- [x] `document.documentElement.scrollWidth` does not exceed viewport width at 1366px or 1920px.
- [x] Mobile sections have no visible seams or line breaks between sections 1–6.
- [x] The Two Perspectives section has even, restrained top and bottom spacing.
- [x] The Attorney Assistant remains readable and visually consistent at mobile and desktop widths.
- [x] Reduced-motion mode presents every section in a stable readable position.

### Phase 4 completion evidence

- Files changed for this phase: `frontend/index.html`, `frontend/assets/scripts/homepage.js`, `frontend/assets/styles/homepage.css`, `frontend/assets/styles/homepage-hybrid.css`, `backend/tests/playwright/accessibility/homepage-phase-four.spec.js`, and this checklist. No backend, authentication, application, payment, profile, or API logic was changed.
- Root causes: the Paths and Closing constellation canvases were scaled and rotated beyond their section widths, the Assistant preview entered from a 150px horizontal offset, and invisible mobile workflow spacer chapters were still enrolled in the generic reveal transform. Together those source transforms produced the audited desktop overflow and mobile seams.
- Source-level remediation: constellation DOM transforms now retain the approved dramatic vertical parallax without horizontal scaling or rotation; the Assistant preview enters vertically within its own stage; and pinned workflow spacer chapters no longer receive reveal transforms. Page-level `overflow-x: clip` masking was removed so the geometry must remain correct on its own.
- Cascade cleanup: Phase 4 added no `!important` overrides. Incorrect Assistant and pinned-workflow `!important` declarations in the affected source blocks were removed, allowing the intended source order and selector scope to control desktop, mobile, and reduced-motion layouts.
- Approved visual safeguards: the cornflower-blue constellation remains owned by Two Perspectives, no constellation eyebrow was added beneath the header, the role-entry scene retains its parallax layers, and Answers Before You Get Started is no longer registered as a cinematic motion layer.
- Pacing assessment: the normal mobile workflow keeps its deliberate 408svh six-beat pinned narrative with a visible active stage at every beat. Role-path, Assistant, and Clarity heights are filled by their real content with contiguous scene boundaries and balanced section padding. In reduced-motion mode the pinned stage and spacer height are removed, and all six workflow chapters and mockups become visible in normal document flow.
- Browser regression: `homepage-phase-four.spec.js` passed 12/12 journeys in Chromium, Firefox, and WebKit. It checks all required 320x844, 390x844, 768x1024, 1366x900, and 1920x1080 viewports across sampled scroll positions, all six mobile workflow states, role-path continuity, Assistant content parity, focus-ring clearance, approved motion ownership, cornflower canvas output, and reduced-motion flow.
- The focused homepage WCAG suite still reports one pre-existing Phase 9 semantic issue: three decorative completed-task `<i>` elements carry `aria-label` without a permitted role. Phase 4 did not alter those elements or expand into semantic cleanup.
- Static verification: JavaScript syntax and scoped diff checks passed.

---

## Phase 5 — Rebuild the two public help-page shells

Goal: make Attorney Help and Paralegal Help coherent public resources while preserving all help content and backend/support behavior.

### Shared-shell checklist

- [x] Decide and document one public-help layout shared by `/help.html` and `/paralegalhelp.html`.
- [x] Remove the misleading anonymous “Member” identity presentation.
- [x] Remove or relocate dashboard/profile links that merely redirect a public visitor to sign-in.
- [x] Use the public LPC wordmark/header treatment appropriate to anonymous pages.
- [x] Add the shared public footer unless a documented content reason requires otherwise.
- [x] Preserve role-specific Attorney Help and Paralegal Help content.
- [x] Preserve incident-intake, Assistant, and support behaviors without modifying their APIs.

### Responsive checklist

- [x] Remove the Attorney Help mobile drawer’s approximately `x=-98px` clipping.
- [x] Remove the Paralegal Help mobile drawer’s approximately `x=-131px` clipping.
- [x] Ensure all menu labels, profile/help information, and close controls remain within the viewport.
- [x] Normalize the 36x36 and 42x42 mobile menu controls to one touch-safe size.
- [x] Normalize “Show menu” and “Open menu” accessibility naming.
- [x] Reconcile Attorney Help’s 28px mobile top padding with Paralegal Help’s 96px.
- [x] Reconcile the desktop content systems: Attorney x≈248/width≈1118 and Paralegal x≈357/width≈900.
- [x] Choose one scrolling model rather than fixed-body/internal-scroll on one page and document-scroll on the other.
- [x] Ensure fixed navigation never traps page content or keyboard focus.

### Verification checklist

- [x] Both help pages clearly identify the visitor’s role without pretending they are signed in.
- [x] Both use the same header, navigation, content-width, spacing, and mobile-menu principles.
- [x] Mobile menus are fully visible at 320px and 390px.
- [x] Help navigation, incident reporting, and Assistant entry points continue to work.
- [x] Links to protected features are either removed, truthfully labeled, or intentionally routed through authentication.

### Phase 5 implementation record — complete August 28, 2026

- Files changed for this phase: `frontend/help.html`, `frontend/paralegalhelp.html`, `frontend/assets/styles/help-pages.css`, `frontend/assets/scripts/help-pages.js`, `frontend/assets/styles/public-site-chrome.css`, `frontend/assets/scripts/public-site-chrome.js`, `backend/tests/playwright/accessibility/help-pages-phase-five.spec.js`, and this checklist. No backend, authentication, support API, incident API, profile, payment, or data logic was changed.
- Shared-layout decision: both Help pages now use the public LPC header and footer, a role-specific editorial hero with an Attorney/Paralegal guide switcher, a shared `1120px` content system, a sticky in-page directory on desktop, and the same normal document-flow layout on tablet and mobile. The old authenticated sidebar model was removed from both pages rather than restyled.
- Anonymous truthfulness: the “Dashboard”/“Member” identity surface and direct dashboard/profile-settings navigation were removed. Protected product locations mentioned inside the guidance are now presented as interface labels, while the shared header truthfully offers Sign In or the authenticated user’s Dashboard.
- Role content: the attorney guide retains account access, Matter posting, hiring, workflow, private-task, funding, release, and dispute guidance. The paralegal guide retains account access, applications/invitations, Matter work, Stripe Connect/payout, withdrawal, and dispute guidance.
- Support behavior: the existing structured incident intake and its `/api/incidents` contract were preserved. Approved signed-in users still receive the role-aware Assistant through the existing support drawer module; anonymous users receive the public guidance and the existing signed-in reporting explanation.
- Responsive correction: both legacy mobile drawers, their negative transforms, their conflicting 28px/96px top spacing, and their fixed-body/internal-scroll behavior were deleted. Both pages now use the shared 44x44 public navigation control with one “Open navigation”/“Close navigation” naming model.
- Keyboard correction: the closed mobile navigation is inert, becomes focusable only while open, closes on Escape, and returns focus to its toggle. The public menu and every visible control remain inside the viewport at 320px, 390px, and 768px.
- Browser verification: `help-pages-phase-five.spec.js` passed 18/18 journeys in Chromium, Firefox, and WebKit. It covers anonymous layout/WCAG checks at 320x844, 390x844, 768x1024, 1366x900, and 1920x1080; matching page geometry; menu bounds and keyboard behavior; protected-link removal; signed-in incident submission; and opening/closing the role-aware Assistant.
- Shared public regression: 15/16 existing Chromium public-page checks passed. The only failure is the previously documented Phase 9 homepage issue involving `aria-label` on three decorative completed-task `<i>` elements; all other public pages and the shared keyboard-focus check passed.
- Static verification: JavaScript syntax, scoped legacy-shell searches, and `git diff --check` passed. No backend route, controller, data model, API contract, or support logic was changed.

### Phases 1–5 integrity recheck — August 28, 2026

- The checklist summary and phase-status table were reconciled so both now correctly identify Phases 1–5 as complete and Phases 6–10 as not started.
- The complete focused regression set passed 60/60 journeys across Chromium, Firefox, and WebKit: Phase 1 public/account-menu isolation, Phase 2 sorting and filters, Phase 3 responsive directory states and touch interactions, Phase 4 homepage geometry/pacing/reduced motion, and Phase 5 public Help shells/support behavior.
- The Phase 5 suite was rerun after a no-behavior code-quality cleanup and passed 18/18 again across all three browsers.
- The adjacent Chromium public-page smoke suite passed 15/16. Its only failure remains the already documented Phase 9 homepage semantic issue: three decorative completed-task `<i>` elements use `aria-label` without a permitted role.
- Application and regression-spec JavaScript syntax checks, `git diff --check`, and the Help-page role-content preservation comparison passed.
- The frontend hygiene gate reports only the three Admission local-fragment links already assigned to Phase 6: `#how`, `#for-attorneys`, and `#for-paralegals`.
- The frontend binding gate no longer reports either Phase 5 script. Its remaining findings are pre-existing authenticated-product/session bindings outside the completed public visual phases (`attorney-tabs.js` and `utils/session.js`).

---

## Phase 6 — Unify legal and utility pages

Goal: make Privacy, Terms, Accessibility, Contact, Admission, FAQs, and 404 feel like one public family while retaining their appropriate content hierarchy.

### Legal-document checklist

- [x] Move Terms onto the shared legal-document system used by Privacy where practical.
- [x] Remove justified mobile body text from Terms.
- [x] Eliminate large inter-word spacing and typography rivers.
- [x] Give Terms and Privacy compatible table-of-contents treatments.
- [x] Normalize legal heading levels, rules, paragraph rhythm, link styling, and anchor offsets.
- [x] Reconcile the Terms browser title “Terms & Conditions” with the visible “Terms of Service” naming.
- [x] Preserve every legal clause and anchor destination; visual work must not rewrite legal substance without separate approval.
- [x] Confirm long Terms content remains readable and navigable at 320px.

### Utility-layout checklist

- [x] Establish a shared mobile content gutter for legal and utility pages, with documented exceptions.
- [x] Reconcile current gutters: Privacy/FAQs 20px, Terms/Contact/Admission 24px, Accessibility 32px, Browse 16px, and 404 14px.
- [x] Review Admission’s mobile hero, whose content starts 120–186px later than comparable utility pages.
- [x] Reduce accidental empty hero space while preserving its distinct editorial emphasis.
- [x] Align Contact button geometry with the public button standard while preserving submission behavior.
- [x] Decide whether 404 should retain its distinct 5px-radius action style or join the public CTA system.
- [x] Preserve the strong existing 404 mobile layout and true unknown-route response.

### FAQ and footer-link checklist

- [x] Give Attorney FAQ and Paralegal FAQ a recognizable shared structural template.
- [x] Preserve role-specific attorney minimum-compensation material.
- [x] Normalize intro-to-TOC spacing and hierarchy between the FAQ pages.
- [x] Fix Admission footer links currently pointing to nonexistent local hashes: `#how`, `#for-attorneys`, and `#for-paralegals`.
- [x] Point those links to their actual destinations without changing server routing.
- [x] Check every legal/utility table-of-contents and footer anchor after layout changes.

### Verification checklist

- [x] Terms and Privacy share consistent reading typography and navigation patterns.
- [x] No legal text is lost, rewritten, or reordered unintentionally.
- [x] Admission footer navigation reaches real sections.
- [x] Utility headers and footers remain dimensionally consistent.
- [x] All utility pages reflow without clipping at all five target viewports.

### Phase 6 implementation record — complete August 28, 2026

- Expected and actual visual-source scope: `frontend/privacy.html`, `frontend/terms.html`, `frontend/accessibility.html`, `frontend/contact.html`, `frontend/paralegal-admission.html`, `frontend/attorney-faq.html`, `frontend/paralegal-faq.html`, `frontend/404.html`, `frontend/browse-paralegals.html`, `frontend/assets/styles/legal-documents.css`, `frontend/assets/styles/utility-pages.css`, `frontend/assets/styles/faq-pages.css`, `frontend/assets/styles/error-page.css`, and `frontend/assets/scripts/public-site-chrome.js`. Verification scope added `backend/tests/playwright/accessibility/utility-pages-phase-six.spec.js` and this checklist. The superseded untracked `legal-mobile.css` override layer was retired rather than retained as an `!important` patch.
- Legal documents: Terms now uses the same `legal-document` and `document-toc` system as Privacy. The justified paragraph/list styling and legacy Terms-only visual rules were removed; headings, rules, links, paragraph rhythm, focus, and 96px anchor offsets now come from one source. The browser title now says “Terms of Service,” and both visible metadata rows retain the required `2026-08-15` legal version.
- Legal integrity: the Phase 6 edit changed wrappers, classes, title metadata, and TOC list semantics only; it did not edit or reorder legal clauses. Automated coverage confirms all 24 Terms sections, all 14 Privacy sections, and every one of their TOC destinations remain present. The legal-document integrity gate passes and produced current SHA-256 evidence for both documents.
- Utility layout: legal, FAQ, Accessibility, Contact, Admission, directory, and 404 content now resolve to the 20px compact-mobile gutter. Desktop/tablet widths retain purpose-specific readable maximums; the 404’s sparse composition remains the documented layout exception, not its former 14px gutter.
- Admission: the 360px empty mobile hero treatment and page-local `!important` stack were removed. A 220px text-only utility hero preserves its editorial identity without the accidental blank row. Its footer now participates in shared public chrome, and its static How It Works/For Attorneys/For Paralegals links point to `/index.html#how`, `/index.html#for-attorneys`, and `/index.html#for-paralegals`.
- Contact and 404: Contact’s form/details alignment is now a source-level responsive grid, its submit action is the 48px public pill, and mocked submission confirms the existing CSRF/request/success behavior. 404 joined the public pill action system while keeping its strong sparse layout; root-relative assets and shared navigation now keep even nested unknown routes branded and functional while returning HTTP 404.
- FAQs: both role pages now rely on one shared page system and `faq-toc` structure instead of competing inline body/main/TOC rules. Both retain 11 TOC destinations and 11 answer sections, and Attorney FAQ retains “Minimum Matter compensation is $400.”
- Cross-browser verification: `utility-pages-phase-six.spec.js` passed 54/54 journeys across Chromium, Firefox, and WebKit. It covers all five required viewports, shared 20px mobile gutters, horizontal clipping, legal content/anchor preservation, FAQ structure, Admission height/links, Contact submission, nested-route 404 behavior/assets, and focused WCAG A/AA scans for all eight Phase 6 surfaces.
- Visual and adjacent regression evidence: the existing public visual/WCAG suite passed 8/8 targeted Chromium pages and saved mobile/desktop captures under `backend/test-results/visual-brand-audit/phase6/public/`. The complete Phases 1–5 focused regression set passed 60/60 across Chromium, Firefox, and WebKit after the shared gutter and navigation changes.
- Static verification: frontend hygiene, legal integrity, JavaScript syntax, and scoped diff checks passed. The frontend binding gate still reports only the previously documented authenticated-product/session findings in `attorney-tabs.js` and `utils/session.js`; no Phase 6 file introduced a new binding finding.

---

## Phase 7 — Refine authentication and account-state visuals

Goal: make login, signup, recovery, verification, and application states visually coherent and factually accurate without changing account logic.

### Responsive-family checklist

- [x] Choose a consistent mobile treatment for the dark art panel across login, signup, forgot password, reset password, and verify email.
- [x] Remove decorative mobile tails that create unnecessary page height unless retained deliberately across the full family.
- [x] Preserve desktop split-screen behavior where it remains appropriate.
- [x] Ensure form content stays vertically balanced on short and tall mobile screens.

### Language and control checklist

- [x] Establish one vocabulary for browser titles, headings, and links: Login/Sign in/Log in.
- [x] Establish one vocabulary for Sign up/Create an account/Create your account.
- [x] Normalize primary button capitalization, including “Reset password.”
- [x] Normalize password toggles currently rendered as “Show password,” “Show,” and lowercase “show.”
- [x] Reconcile the reset page’s straight apostrophe/hyphen title punctuation with the rest of the site.
- [x] Normalize auth and recovery control heights and radii while retaining appropriate hierarchy.

### Reset-password checklist

- [x] Replace the green checkmark emoji in the success state with the approved contemporary success treatment.
- [x] Replace ASCII `...` with consistent copy/punctuation.
- [x] Remove or correct the stale disabled “Saving...” button after success.
- [x] Present a stable success state during any intentional redirect delay.
- [x] Make missing, malformed, invalid, and expired token states visually consistent.
- [x] Where current backend capability allows, avoid presenting the full password form for a token already known to be unusable.
- [x] Do not add or alter token-validation APIs in this visual phase.

### Verification and application checklist

- [x] Change the verify-email headline from “Verifying your email” after success.
- [x] Use an appropriate error headline after failure.
- [x] Preserve the approved verified-under-review message.
- [x] Preserve Return home as the only success action for a pending applicant.
- [x] Do not reintroduce Continue to sign in or Go to sign in.
- [x] Remove the stale “Creating an account is free.” line from the submitted application state if it remains outside the active form context.
- [x] Correct copy implying that administrative review begins only after email verification.
- [x] Describe the actual sequence without changing that sequence.
- [x] Preserve the approved removal of the dated checkmark, three-step treatment, and unnecessary sign-in CTA from application submission.

### Verification checklist

- [x] Login, signup, forgot, reset, and verify pages read as one visual family at mobile and desktop sizes.
- [x] Password toggles use consistent labels and remain accessible.
- [x] Reset success no longer contains emoji or stale loading language.
- [x] Verify success and failure use state-appropriate headlines.
- [x] Application confirmation copy matches existing backend behavior.
- [x] Signup role transitions, validation, Turnstile boundary, and submission logic remain unchanged.

### Phase 7 implementation record — complete August 28, 2026

- Expected and actual visual-source scope: `frontend/login.html`, `frontend/signup.html`, `frontend/forgot-password.html`, `frontend/reset-password.html`, `frontend/verify-email.html`, `frontend/assets/styles/auth-secondary.css`, `frontend/assets/styles/auth-google.css`, `frontend/assets/scripts/login.js`, `frontend/assets/scripts/reset-password.js`, and `frontend/assets/scripts/verify-email.js`. Verification scope added `backend/tests/playwright/accessibility/auth-pages-phase-seven.spec.js` and this checklist. No backend route, model, API contract, token rule, application-review rule, email-delivery rule, or account-access rule was changed.
- Responsive family: all five pages keep the dark 42/58 constellation split on desktop and use a full-width white form/state surface at 768px and below. The former forgot/reset 270px mobile art block and verify-email 36% dark tail were removed at their source. The mobile panels now use the same header height, gutters, minimum viewport height, and vertically centered content behavior through the 320px, 390px, 768px, 1366px, and 1920px verification matrix.
- Language and controls: “Sign in” is the login vocabulary and “Create an account” is the signup vocabulary in titles, headings, and cross-links. Password toggles consistently say “Show password”/“Hide password”; auth inputs, Google actions, and primary actions use 50px heights and restrained 8px radii. Reset titles now use LPC’s curly apostrophe and en dash punctuation, and primary actions use sentence capitalization.
- Reset states: missing and locally malformed tokens immediately replace and hide the full form; backend-reported invalid, expired, or used tokens resolve into the same unavailable-link presentation. Successful resets replace the form and transient “Saving…” label with a stable “Your password is reset” state during the existing three-second redirect delay. Emoji and ASCII-ellipsis messaging were removed. The existing `/api/csrf` and `/api/auth/reset-password` calls, single-use token contract, password policy, and redirect destination remain unchanged.
- Verification and application truthfulness: verify-email now changes its eyebrow, headline, status role, and document title for success and failure. Success states preserve Return home as the only action and say that the application remains under review; no sign-in CTA exists. Signup confirmation now states that review is already underway and that email verification confirms the address for account notices. The active-form pricing note, form, heading, and role controls are hidden after submission, and the approved no-checkmark/no-three-step/no-sign-in confirmation remains intact.
- Existing integration boundaries: forgot password still obtains CSRF and posts the same email payload before showing its confirmation dialog; verify email still posts the same token; signup still blocks registration without a Turnstile token and submits through the same secure fetch; Google URLs and explicit passkey behavior remain unchanged. The silent conditional-passkey autofill probe now suppresses only the global generic error toast because that probe already handles failures silently by design; explicit passkey-action failures remain visible.
- Cross-browser verification: `auth-pages-phase-seven.spec.js` passed 15/15 journeys across Chromium, Firefox, and WebKit. It covers the five required viewports, desktop/mobile art behavior, horizontal clipping, control geometry, vocabulary, password toggles, forgot-password request/dialog behavior, malformed/expired/success reset states, verification success/error states, signup role progression, the Turnstile boundary, truthful submitted copy, and focused WCAG A/AA scans of terminal states.
- Visual and adjacent regression evidence: the existing public visual/WCAG suite passed 15/15 focused auth-page checks across Chromium, Firefox, and WebKit. Ten desktop/mobile renders were inspected under `backend/test-results/visual-brand-audit/phase7/public/`; a follow-up render confirmed removal of the unintended initial-login “Item not found” toast.
- Static verification: frontend hygiene, legal integrity, JavaScript syntax, auth-fetch navigation contracts, scoped terminology scans, and scoped diff checks passed. The frontend binding gate still reports only the previously documented authenticated-product/session findings in `attorney-tabs.js` and `utils/session.js`; no Phase 7 file introduced a new binding finding.

---

## Phase 8 — Consolidate the public design system

Goal: remove repeated one-off visual decisions after page-specific defects are resolved.

### Button-system checklist

- [x] Inventory final button variants after Phases 1–7.
- [x] Define allowed public button roles: primary, secondary, text/link, icon, pagination, and destructive if applicable.
- [x] Define desktop and mobile minimum heights.
- [x] Require at least 44x44px touch targets for mobile interactive controls, or an equivalently sized clickable wrapper.
- [x] Define when pill radius is appropriate and when a restrained rounded rectangle is appropriate.
- [x] Reconcile current treatments: marketing pills, 46px auth buttons, 54px recovery buttons, square Contact button, 5px 404 buttons, and 31px pagination.
- [x] Remove unexplained gold/brown primary actions where navy is the established public primary.
- [x] Preserve gold as a deliberate accent rather than a competing primary-action color.
- [x] Normalize hover, active, focus-visible, disabled, loading, and selected states.

### Spacing and typography checklist

- [x] Define public content-width and gutter tokens for compact mobile, mobile, tablet, desktop, and wide desktop.
- [x] Define the allowable display-heading scale and its page-role exceptions.
- [x] Normalize control-label and button capitalization.
- [x] Normalize curly apostrophe, en dash, ellipsis, and product-name punctuation.
- [x] Keep Cormorant Garamond and Sarabun roles consistent with the existing LPC brand system.
- [x] Do not flatten intentionally editorial homepage typography into product-interface typography.

### Shared chrome checklist

- [x] Normalize the public header’s mobile and desktop geometry across all public pages.
- [x] Normalize public footer spacing and typography across all public pages.
- [x] Reconcile the accessibility toggle’s approximately 76x16 treatment with Browse’s approximately 94x28 override.
- [x] Provide one comfortable, consistent accessibility-toggle target.
- [x] Remove page-local overrides that unintentionally restyle shared footer components.
- [x] Keep homepage and utility mobile navigation behavior consistent.

### Verification checklist

- [x] Each public button maps to a documented role.
- [x] No page needs an unexplained one-off primary action color, height, or radius.
- [x] Shared header/footer controls have the same dimensions unless an exception is documented.
- [x] Typography and spacing remain recognizably LPC rather than becoming generic.

### Phase 8 implementation record — complete August 28, 2026

- Visual-source scope: all 17 inventoried public documents now load `frontend/assets/styles/public-design-system.css`. The shared implementation was completed in `frontend/assets/styles/public-design-system.css`, `frontend/assets/styles/public-site-chrome.css`, `frontend/assets/scripts/public-site-chrome.js`, `frontend/assets/styles/hero-pages.css`, `frontend/assets/styles/homepage.css`, `frontend/assets/styles/homepage-hybrid.css`, `frontend/assets/styles/error-page.css`, `frontend/assets/styles/auth-secondary.css`, `frontend/assets/styles/help-pages.css`, `frontend/assets/scripts/browse-paralegals.js`, `frontend/assets/scripts/help-incident-intake.js`, and `frontend/assets/scripts/utils/support-drawer.js`, with public action-role annotations in the 17 page documents. Verification-source scope added `backend/tests/playwright/accessibility/public-design-system-phase-eight.spec.js` and updated only affected visual/copy assertions in the existing Phase 2, 4, 5, 6, 7, and launch-quality specifications. No backend application route, model, service, API, authorization rule, account-review rule, email workflow, or persistence logic was changed.
- Documented system: `docs/LPC_PUBLIC_DESIGN_SYSTEM.md` records LPC color roles, Sarabun/Cormorant typography ownership, five responsive gutter/content-width tiers, heading scales and exceptions, action roles, control geometry, state behavior, shared chrome, and the intentionally editorial homepage exception.
- Action consolidation: every operative public action maps to primary, secondary, text, icon, pagination, or destructive semantics through `data-public-action`. Navy is the sole standard primary fill; gold remains an accent/focus/text color. Interface controls use restrained rounded rectangles, while marketing CTAs and pagination may use pills. Mobile interactive targets are at least 44px; auth, modal, Contact, Browse, Help, recovery, and 404 geometries were reconciled at their source.
- Chrome consolidation: the public family uses one 72px desktop/66px mobile header, one navy footer source, one 44px mobile menu target, and one 44px accessibility-toggle target. The homepage now consumes the same chrome geometry while retaining its approved editorial styling and motion. Obsolete utility-header, white-footer, Browse-footer, duplicate homepage-footer, and duplicated accessibility-toggle rules were deleted instead of being masked. The shared chrome and utility hero sources contain no `!important` declarations.
- Copy and typography: public interface labels use sentence case, product naming is consistent, “Name A–Z” uses an en dash, and loading copy uses a typographic ellipsis. Utility, FAQ, Help, and Browse body copy resolves to Sarabun; branded display headings retain Cormorant Garamond; the homepage’s editorial scale remains explicitly protected.
- Phase 8 browser verification: `public-design-system-phase-eight.spec.js` passed 21/21 tests in Chromium, Firefox, and WebKit. It covers all 17 public surfaces at 320x844, 390x844, 768x1024, 1366x900, and 1920x1080; action-role validity; 44px mobile targets; primary-color use; overflow; shared header/footer/accessibility geometry; mobile navigation; and reconciled control dimensions.
- Prior-phase regression: the complete Phase 1–7 public suite passed 129/129 tests across Chromium, Firefox, and WebKit after consolidation. Frontend hygiene passed with 36 HTML entry points, 460 local asset references, 63 reachable modules, and 30 reachable stylesheets; legal integrity passed; all 586 JavaScript files parsed; launch-quality contracts passed 13/13; and `git diff --check` passed.
- Out-of-scope repository note: the aggregate authenticated-product browser-contract command clears auth requests, public session navigation, and dialog contracts before stopping on an existing Attorney global-search heading-font assertion. That protected-product typography and its already-modified test/style files are outside Phase 8’s public-page visual scope and were not changed here.

---

## Phase 9 — Accessibility, semantics, navigation, and truthfulness

Goal: clear the known automated failures and manually validate the interaction semantics affected by the visual remediation.

### Known accessibility defects

- [x] Replace or correctly role the three homepage completion `<i>` elements carrying `aria-label="Complete"`.
- [x] Remove prohibited ARIA attributes from elements without a valid semantic role.
- [x] Confirm the Browse post-footer `aria-hidden-focus` violation was eliminated in Phase 1.
- [x] Re-run the configured WCAG A/AA suite and achieve zero known serious public-page violations.

### Keyboard and focus checklist

- [x] Traverse every public header and mobile menu by keyboard.
- [x] Traverse Browse sort, filter, pagination, account-required prompt, and close controls by keyboard.
- [x] Traverse every auth form, password toggle, modal, and success/error action by keyboard.
- [x] Confirm focus is never trapped behind a closed menu, drawer, or modal.
- [x] Confirm opening components move focus only when appropriate.
- [x] Confirm closing components restores focus to a logical trigger.
- [x] Confirm all focus indicators remain visible against white, cloud, cream, navy, and cornflower-blue surfaces.

### Navigation and copy-integrity checklist

- [x] Re-crawl all public internal links and hash destinations.
- [x] Confirm the three repaired Admission links resolve correctly.
- [x] Confirm removed public routes are not linked or referenced in application source.
- [x] Confirm public help links do not create misleading authenticated destinations.
- [x] Confirm Browse signed-out copy matches actual anonymous capabilities.
- [x] Confirm signup confirmation accurately describes review and verification.
- [x] Confirm verify-email success does not invite an unapproved applicant to sign in.
- [x] Confirm headings change correctly for loading, success, and error states.

### Manual accessibility checklist

- [x] Check heading order on all 17 public surfaces.
- [x] Check form labels, instructions, validation association, and error announcement.
- [x] Check zoom/reflow at 200% or the project’s equivalent 720px reflow gate.
- [x] Check reduced-motion behavior on the homepage and any animated menu/modal.
- [x] Check color contrast for text, links, controls, borders, selected states, and focus indicators.
- [x] Check that thin decorative borders are not the only state indicator.
- [x] Check that hidden decorative artwork does not become screen-reader noise.

### Phase 9 implementation record — complete August 28, 2026

- Visual and semantic source scope: `frontend/index.html`, `frontend/login.html`, `frontend/signup.html`, `frontend/browse-paralegals.html`, `frontend/assets/scripts/homepage.js`, `frontend/assets/scripts/public-site-chrome.js`, `frontend/assets/styles/public-design-system.css`, `frontend/assets/styles/public-site-chrome.css`, `frontend/assets/styles/homepage.css`, and `frontend/assets/styles/help-pages.css`. Audit documentation was corrected in `docs/LPC_VISUAL_BRAND_AUDIT_AND_REMEDIATION.md`. Verification scope added `backend/tests/playwright/accessibility/public-accessibility-phase-nine.spec.js`, expanded `backend/tests/playwright/accessibility/public-pages.spec.js` to both Help guides, corrected the keyboard-focus assumption in `public-design-system-phase-eight.spec.js`, and updated this checklist. No backend application route, model, service, authorization rule, API payload, account status, review workflow, email workflow, or persistence behavior was changed.
- Semantic cleanup: the three visible homepage completion marks and the same hidden workflow-state source mark are now decorative `aria-hidden` elements instead of generic `<i>` elements with prohibited accessible names. Login now exposes “Sign in to Let’s-ParaConnect” as the single page-level `<h1>` while the wordmark remains a non-heading brand link. All 17 surfaces begin their visible heading hierarchy at one `<h1>` without skipped levels.
- Hidden-content and navigation behavior: homepage and shared public mobile menus initialize closed with `inert`, remove it only while open, preserve keyboard activation, and restore their trigger when Escape closes a menu from within it. Every public header implementation, Browse disclosure/dialog system, forgot-password dialog, auth state, and Help surface was traversed without focus entering closed or `aria-hidden` content. Decorative canvases and matter-field artwork remain outside the accessibility tree.
- Focus and state perception: the shared focus token is the darker LPC gold `#887244`, providing at least 3:1 non-text contrast on LPC light and dark public surfaces. Header/footer navigation, homepage FAQ controls, Help role/directory/content links, Browse sort/filter fields and list options, login/signup inputs, and primary actions now retain explicit visible focus without relying on a thin border or subtle color change. Selected sort and signup-role states preserve semantic state plus a visible fill change.
- Reflow and motion: every public surface passed the 720px 200%-equivalent reflow gate without horizontal overflow. Shared mobile navigation transitions and smooth scrolling stop under `prefers-reduced-motion: reduce`; existing homepage, Help, auth, FAQ, and utility reduced-motion safeguards remain intact.
- Navigation integrity: the runtime crawl covered every internal link and hash exposed by all 17 public surfaces. All destinations return successfully, all fragment IDs exist, and Admission’s How It Works, For Attorneys, and For Paralegals links resolve to the corresponding homepage sections. Removed public routes have no literal application-source or audit-document references. Help article links remain within the public route set rather than sending anonymous readers into protected product UI.
- Copy truthfulness: Browse continues to say that browsing and filtering are available without an account and limits sign-in to profiles and inquiries. Signup continues to say review is already underway and email verification confirms the notice address. Verify-email success retains the under-review explanation and Return home as its only action; loading, success, and error headings remain state-appropriate.
- Phase 9 and WCAG verification: the combined cross-browser run completed with 73 passes and two intentional skips. The Phase 9 suite passed 19 browser tests, with its browser-independent runtime link crawl run once in Chromium and intentionally skipped in Firefox/WebKit. The expanded public WCAG A/AA suite passed 54/54 checks across all 17 surfaces in Chromium, Firefox, and WebKit with zero violations.
- Prior-phase and static regression: all 150 Phase 1–8 cases are green. The aggregate run passed 149/150 and surfaced one stale WebKit pointer-focus assumption in the Phase 8 test; the corrected keyboard assertion then passed 3/3 across Chromium, Firefox, and WebKit. Frontend hygiene passed with 36 HTML entry points, 460 asset references, 63 reachable modules, and 30 reachable stylesheets; legal integrity passed; all 587 JavaScript files parsed; 162 frontend API literals matched 349 mounted route patterns; launch-quality contracts passed 13/13; and `git diff --check` passed.

---

## Phase 10 — Full public-page regression and certification

Goal: prove the complete public experience is consistent and functional after all nine remediation phases.

### Full viewport matrix

- [x] Render all 17 public surfaces at 320x844.
- [x] Render all 17 public surfaces at 390x844.
- [x] Render all 17 public surfaces at 768x1024.
- [x] Render all 17 public surfaces at 1366x900.
- [x] Render all 17 public surfaces at 1920x1080.
- [x] Add compact-landscape coverage where navigation, help drawers, or forms require it.
- [x] Compare every final capture with the 2026-08-28 audit evidence.

### State and interaction matrix

- [x] Home: mobile menu, parallax chapters, assistant preview, role paths, and reduced motion.
- [x] Browse: loading, populated, empty, error, fallback photo, sort options, every filter family, pagination, signed-out prompt, and footer.
- [x] Login: password visibility, Google boundary, passkey boundary, validation, loading, pending-account response, and mobile layout.
- [x] Signup: role selection, attorney form, paralegal form, validation, Turnstile boundary, and submitted-application confirmation.
- [x] Forgot password: validation, loading, generic confirmation modal, focus trap, Done action, and error state.
- [x] Reset password: missing token, invalid token, expired token, validation, loading, success, and error.
- [x] Verify email: loading, success, invalid/expired token, error, Return home action, and pending-review copy.
- [x] Contact: validation, loading, success, error, and responsive action layout.
- [x] Legal/utility: long content, tables of contents, anchors, mobile menu, footer navigation, and 404 response.
- [x] Help pages: public navigation, role-specific content, mobile menu, Assistant entry, and incident intake.

### Regression boundaries

- [x] Verify all 19 protected frontend documents still redirect anonymous visitors to `/login.html`.
- [x] Verify visual work did not change API endpoints, payloads, auth checks, account statuses, email workflow, application review, or persistence.
- [x] Verify OAuth, passkey, Turnstile, and email links retain their original integration boundaries.
- [x] Verify no public page produces unexpected console errors.
- [x] Verify no public page has horizontal overflow at any required viewport.
- [x] Verify no persistent loading copy remains after deterministic mock responses settle.
- [x] Verify no missing images, fonts, stylesheets, modules, or scripts.
- [x] Verify unknown routes still return the branded 404 with a true 404 status.

### Final quality gates

- [x] All known critical and high-priority issues are closed.
- [x] All medium and low issues are closed or explicitly accepted by the user.
- [x] Automated public accessibility suite passes.
- [x] Public link/hash crawl passes.
- [x] Sort/filter keyboard and pointer journeys pass.
- [x] Responsive screenshot review passes at all five target sizes.
- [ ] Working-tree diff contains only intended visual/public-page changes and audit artifacts.
- [x] Final report lists every changed file, test command, result, accepted exception, and remaining risk.
- [ ] User performs or explicitly waives final visual approval before any deployment work.

### Phase 10 implementation record — verification complete August 28, 2026

- Phase 10 source scope: `frontend/assets/styles/public-site-chrome.css`, `backend/tests/playwright/accessibility/public-certification-phase-ten.spec.js`, and this checklist. The shared CSS correction keeps the unfocused skip link completely outside the viewport and restores it on keyboard focus; it also removes that transition under reduced motion. No `!important` declaration was added. No backend application route, model, service, authorization rule, API payload, account status, review workflow, email workflow, or persistence behavior was changed.
- Responsive evidence: 85 fresh full-page captures cover all 17 public surfaces at 320x844, 390x844, 768x1024, 1366x900, and 1920x1080 in `test-results/public-phase10-20260828/viewports/`. Every capture was reviewed against the August 28 audit evidence. Compact landscape was additionally exercised at 844x390 across every public surface and every shared public-header implementation.
- Visual correction found during certification: the shared fixed skip link left a thin navy edge visible while unfocused on several public-chrome pages. Its offscreen geometry was corrected at the shared source and a per-page assertion now requires its bottom edge to be at or above the viewport boundary before focus. Regenerated evidence confirms the edge is gone.
- Interaction and state coverage: the Phase 10 suite checks all 19 protected redirects; login validation, loading, pending-review, Google, and passkey boundaries; both signup roles, Turnstile, and the application confirmation; forgot-password validation, loading, modal focus, Done, and error; reset missing, invalid, expired, validation, loading, success, and error; verify-email loading, success, missing, invalid, expired, pending-review copy, and Return home-only action; and contact validation, loading, success, error, and mobile action geometry. Phase 1–9 suites retain the complete Home, Browse, Help, FAQ, legal, navigation, filter, accessibility, and incident-intake journeys.
- Phase 10 browser result: the new suite passed 29 applicable Chromium/Firefox/WebKit cases with 10 intentional skips because deterministic screenshot generation runs once in Chromium. Its focused Chromium evidence run passed 13/13.
- Full Phase 1–10 result: the aggregate public accessibility run recorded 251 passes and 12 intentional skips out of 264 cases. One Firefox verify-email WCAG case exceeded its timeout under aggregate load; the exact case then passed three consecutive focused Firefox repetitions in 2.5–2.7 seconds, and the complete Firefox project passed 82 tests with six intentional skips, confirming a timing flake rather than a page failure. All applicable Chromium and WebKit cases passed.
- Static and contract gates: frontend hygiene passed with 36 HTML entry points, 460 asset references, 63 reachable modules, and 30 reachable stylesheets; legal integrity passed; all 588 JavaScript files parsed; 162 frontend API literals matched 349 mounted route patterns; launch-quality UI contracts passed 13/13; auth-fetch, public-auth-navigation, and dialog UI scripts passed; and `git diff --check` passed.
- Accepted exception and remaining release gate: the repository already contains a broad dirty working tree from prior authorized work, so the repository-wide diff cannot honestly be certified as containing only Phase 10 changes. The Phase 10 scoped files are intentional and clean, and unrelated changes were preserved. Final user visual approval remains required before any deployment work.

## Existing behavior that every phase must preserve

- [x] Anonymous access protection for the 19 product pages.
- [x] Navy Browse Apply button.
- [x] Functional mobile Browse sorting and correct underlying values.
- [x] Functional attorney/paralegal signup role transitions.
- [x] Forgot-password modal focus handling.
- [x] Contact success messaging and submission behavior.
- [x] Attorney Assistant mobile/desktop content parity.
- [x] Responsive and readable branded 404 page.
- [x] Shared public mobile navigation behavior.
- [x] No visible homepage section seams on mobile.
- [x] Verified applicants see the under-review message and only Return home.
- [x] Application submission does not show a dated checkmark, three-step list, or sign-in CTA.

## Completion record

| Phase | Started | Completed | Files changed | Verification evidence | User approval |
|---|---|---|---|---|---|
| 1 | 2026-08-28 | 2026-08-28 | `frontend/browse-paralegals.html`; `frontend/assets/scripts/browse-paralegals.js`; `backend/tests/playwright/accessibility/public-directory-account-menu.spec.js`; this checklist | 6/6 cross-browser Phase 1 journeys; 3/3 cross-browser Browse WCAG checks; syntax and scoped diff checks passed | Execution authorized 2026-08-28 |
| 2 | 2026-08-28 | 2026-08-28 | `frontend/browse-paralegals.html`; `frontend/assets/scripts/browse-paralegals.js`; `backend/tests/playwright/accessibility/public-directory-sort-filter.spec.js`; this checklist | 12/12 Phase 2 journeys; 6/6 Phase 1 regressions; 3/3 Browse WCAG checks; syntax and scoped diff checks passed | Execution authorized 2026-08-28 |
| 3 | 2026-08-28 | 2026-08-28 | `frontend/browse-paralegals.html`; `frontend/assets/scripts/browse-paralegals.js`; `backend/tests/playwright/accessibility/public-directory-responsive.spec.js`; this checklist | 12/12 Phase 3 journeys; 18/18 Phase 1–2 regressions; 3/3 Browse WCAG checks; syntax and scoped diff checks passed | Execution authorized 2026-08-28 |
| 4 | 2026-08-28 | 2026-08-28 | `frontend/index.html`; `frontend/assets/scripts/homepage.js`; `frontend/assets/styles/homepage.css`; `frontend/assets/styles/homepage-hybrid.css`; `backend/tests/playwright/accessibility/homepage-phase-four.spec.js`; this checklist | 12/12 Phase 4 journeys across Chromium, Firefox, and WebKit; geometry, pacing, motion ownership, reduced-motion, syntax, and scoped diff checks passed | Execution authorized 2026-08-28 |
| 5 | 2026-08-28 | 2026-08-28 | `frontend/help.html`; `frontend/paralegalhelp.html`; `frontend/assets/styles/help-pages.css`; `frontend/assets/scripts/help-pages.js`; `frontend/assets/styles/public-site-chrome.css`; `frontend/assets/scripts/public-site-chrome.js`; `backend/tests/playwright/accessibility/help-pages-phase-five.spec.js`; this checklist | 18/18 Phase 5 journeys across Chromium, Firefox, and WebKit; responsive/WCAG, keyboard menu, incident submission, Assistant, syntax, and scoped diff checks passed | Execution authorized 2026-08-28 |
| 6 | 2026-08-28 | 2026-08-28 | `frontend/privacy.html`; `frontend/terms.html`; `frontend/accessibility.html`; `frontend/contact.html`; `frontend/paralegal-admission.html`; `frontend/attorney-faq.html`; `frontend/paralegal-faq.html`; `frontend/404.html`; `frontend/browse-paralegals.html`; `frontend/assets/styles/legal-documents.css`; `frontend/assets/styles/utility-pages.css`; `frontend/assets/styles/faq-pages.css`; `frontend/assets/styles/error-page.css`; `frontend/assets/scripts/public-site-chrome.js`; `backend/tests/playwright/accessibility/utility-pages-phase-six.spec.js`; this checklist | 54/54 Phase 6 cross-browser journeys; 8/8 targeted visual/WCAG pages; 60/60 Phases 1–5 regressions; frontend hygiene, legal integrity, syntax, and scoped diff checks passed | Execution authorized 2026-08-28 |
| 7 | 2026-08-28 | 2026-08-28 | Auth page HTML/CSS/JS; `auth-pages-phase-seven.spec.js`; this checklist | 15/15 Phase 7 cross-browser journeys; focused visual/WCAG, frontend hygiene, legal integrity, syntax, auth-fetch navigation contracts, and scoped diff checks passed | Execution authorized 2026-08-28 |
| 8 | 2026-08-28 | 2026-08-28 | 17 public page documents; shared public design-system/chrome and affected page CSS/JS; `public-design-system-phase-eight.spec.js`; design-system documentation; this checklist | 21/21 Phase 8 cross-browser tests; 129/129 Phase 1–7 regressions; frontend hygiene, legal integrity, syntax, launch-quality contracts, and diff checks passed | Execution authorized 2026-08-28 |
| 9 | 2026-08-28 | 2026-08-28 | Public homepage/login/signup/Browse semantic and focus sources; shared public chrome/design-system and Help focus sources; Phase 9/WCAG Playwright coverage; audit documentation; this checklist | 19 Phase 9 browser tests plus one Chromium link crawl with two intentional cross-browser skips; 54/54 public WCAG checks; all 150 Phase 1–8 cases green; frontend, legal, syntax, API-contract, launch-quality, and diff gates passed | Execution authorized 2026-08-28 |
| 10 | 2026-08-28 | 2026-08-28 (verification) | Shared public skip-link CSS; Phase 10 certification coverage; this checklist | 85 reviewed viewport captures; 29 applicable Phase 10 browser cases passed with 10 intentional screenshot skips; aggregate suite 251 pass/12 skip/1 load timeout, followed by 3/3 focused Firefox passes and a clean 82-pass/6-skip full Firefox project; all static and contract gates passed | Execution authorized 2026-08-28; final visual approval pending |
