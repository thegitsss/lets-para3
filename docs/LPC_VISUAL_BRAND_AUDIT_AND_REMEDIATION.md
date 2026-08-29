# LPC Visual Brand Audit and Remediation

Status: remediation and all locally runnable final verification are complete; candidate creation and pinned-runtime release verification remain gated. No commit, push, deploy, or external-service change is authorized by this document.

Audit date: 2026-08-16  
Certified starting commit: `c29404a1dcc7d4d9991fd387d75b07103e1b7dfe`  
Best pre-remediation comparison tree: `fc24b897167d572ffc8f15fae7ce171d60146b82`

## Purpose and standard

This audit establishes a coherent, production-owned visual system for Let’s-ParaConnect (LPC), verifies every directly reachable document and major authenticated state family, remediates confirmed launch-significant defects, and installs regression checks for the failure modes found.

The target is enterprise quality: clear hierarchy, truthful data presentation, accessible interaction, predictable state behavior, durable component ownership, and restrained brand expression. It does not copy another company’s visual system and does not add decorative product behavior without a user or operational purpose.

## Evidence hierarchy

Visual decisions were resolved in this order:

1. The certified current tree and browser-rendered pre-remediation state.
2. Current local assets, bundled fonts, manifest colors, email/PDF output, and cross-role shared components.
3. Git history, especially the pre-remediation comparison tree and long-lived visual patterns.
4. Existing browser contracts and user-approved product shells.
5. Public production conventions only as secondary usability evidence, never as imported styling.

Historical trees are evidence, not restoration targets. Current security, accessibility, workflow, and responsive improvements remain authoritative even when a prior visual pattern is restored.

### Exact source references

| Evidence | Exact source |
|---|---|
| Last coherent product comparison | Tree `fc24b897167d572ffc8f15fae7ce171d60146b82`; corroborated by restore commits `c8ca742b0ca22482aa3ba86fcf8f5ef8397b59a0` and `777615b212a6475006fa45a616499cb0b677685b`. |
| Drift boundary | Commit `7f8c5bb99666f2f8b37d47f8ec698dd790d7ccd2` introduced the late `product-clean.css` generic sans/gray/purple reset and admin heading override. |
| Local fonts | `frontend/assets/styles/fonts.css`; local WOFF2 files under `frontend/assets/fonts/`; font migration commit `99316a7f42d911e8020f662bbda865721f8942fb`. |
| Public identity | `frontend/assets/styles/homepage.css`, `frontend/index.html`, `frontend/site.webmanifest`, `frontend/Cleanfav.png`, and `frontend/hero-mountain.jpg`. |
| Product identity | `frontend/assets/styles/dashboard-system.css`, authenticated page-local tokens, and the pre-drift `product-clean.css` history. |
| Assistant identity | Navy/gold/Cormorant-compatible layer introduced at `49bdf991becfa1b10aa653d1dedbc93bcbe792a8`; the later system-font/blue layer at `fc24b897167d572ffc8f15fae7ce171d60146b82` was treated as drift. |
| Director exception | Role-local visualization palette introduced at `a958fda5a6d53c4f488f8cdfa5090b0a35a5323c`; retained only for data series. |

## Authoritative brand matrix

### Identity and assets

| Role | Standard |
|---|---|
| Wordmark | Typographic `Let’s-ParaConnect`; Cormorant Garamond 300; dark navy/ink with a gold curly apostrophe. |
| Corporate mark | `frontend/Cleanfav.png`, a 256×256 minimalist mountain mark. It is supporting identity, not a replacement for the wordmark. |
| Hero imagery | `frontend/hero-mountain.jpg`, 1536×1024. Use only where the mountain theme or public narrative owns it. |
| Avatar fallback | `frontend/assets/avatar-placeholder.svg`; one neutral silhouette for all generic image fallbacks. |
| Favicons | `frontend/favicon.ico` and `public/favicon.ico` are identical; `site.webmanifest` corroborates deep navy `#0b2a4a`. |
| Retired material | Old transparent logos, old dashboard screenshots, unused dashboard-preview SVGs, and historical mountain-favicon variants are not brand sources. |

### Typography

| Role | Family | Allowed bundled weights | Use |
|---|---|---:|---|
| Display and identity | Cormorant Garamond | 300, 400, 600 | Wordmark, page titles, product section hierarchy, names where identity is the subject. |
| Interface and copy | Sarabun | 200, 400, 600 | Body copy, labels, controls, dense tables, metadata, and operational metrics. |

No active CSS may request unbundled numeric weights. The hygiene gate rejects weights other than 200, 300, 400, and 600, preventing browser-specific synthesized-weight drift.

### Color roles

| Role | Token/value | Constraint |
|---|---|---|
| Public ink | `#1a2230` | Primary public text and navy actions. |
| Deep ink | `#0a0f14` / manifest `#0b2a4a` | High-contrast dark fields and identity accents. |
| Product ink | `#1a1a1a` | Primary authenticated text. |
| Public gold | `#b4975a` | Decorative or paired with dark text; never white normal-size text. |
| Interactive gold | `#887244` / hover `#6f5d37` | May carry white text; focus and selected-state ownership. |
| Product decorative gold | `#b6a47a` | Borders, indicators, and dark foreground combinations. |
| Product muted | `#5f6670` | Accessible secondary text across white, cloud, cream, and mountain-light surfaces. |
| Public muted | `#626a74` | Secondary public copy. |
| Cloud | `#f3f1ec` | Public utility background. |
| Product page | `#f7f7f5` | Authenticated application background. |
| Product panel | `#ffffff` / `#fcfcfc` | Cards, tables, and sidebar surfaces. |
| Light divider | `rgba(0,0,0,.08)` | Default structural separation. |
| Dark product background | `#0f172a` | Dark and mountain-dark page surface. |
| Dark panel/sidebar | `#151b29` / `#1c2333` | Dark-mode hierarchy. |
| Semantic danger/success/warning | `#a53d3d` / `#247451` / `#9b5d14` | Meaning-bearing states only. |

The Director portal retains its historically intentional, role-scoped blue/rose/purple chart series. Those colors are data encodings, not global action colors.

### Geometry, spacing, icons, and motion

| Area | Standard |
|---|---|
| Spacing rhythm | 8, 12, 16, 24, 32, 40px. |
| Controls | 40–42px desktop; at least 44×44px on touch/mobile. |
| Control radius | 6px. |
| Compact cards/tables | 8–10px. |
| Feature panels and floating product surfaces | 14px. |
| Pills and avatars | 999px / circular only when the shape communicates category or identity. |
| Icons | Inline 24×24 outline SVG, `currentColor`, no fill, 1.5–1.6px round strokes. |
| Shadows | None or subtle on persistent panels; stronger shadows only on floating UI such as dialogs, menus, drawers, and notification popovers. |
| Motion | 160–240ms for affordance, navigation, or state continuity. Reduced-motion mode collapses animations and transitions. |

Public storytelling can use larger geometry and editorial pacing. Those values do not become authenticated-product defaults.

## Reachability and coverage inventory

The server exposes `frontend/` through static middleware and uses the branded 404 after static resolution. There are 38 reachable HTML documents: 30 canonical documents and 8 intentional compatibility redirects.

### Public, authentication, legal, and utility documents

| Surface | Routes | Material states inspected |
|---|---|---|
| Home | `/`, `/index.html` | Guest/member header, desktop/mobile nav, all workflow chapters, both Assistant previews, both role paths, reduced motion. |
| Authentication | `/login.html`, `/signup.html` | Password, Google, passkey, role selection, attorney/paralegal variants, validation, password visibility, 2FA/backup mode, Turnstile boundary, loading/error/success shells. |
| Recovery/verification | `/forgot-password.html`, `/reset-password.html`, `/verify-email.html` | Missing/invalid/expired token, validation, loading, generic confirmation, success/error. |
| Directory | `/browse-paralegals.html` | Guest/authenticated shell, loading/populated/empty/error, filters, pagination, fallback photo, mobile filter, account-required and invitation dialogs. |
| Legal/content | `/privacy.html`, `/terms.html`, `/accessibility.html`, `/paralegal-admission.html`, `/attorney-faq.html`, `/paralegal-faq.html` | Long content, TOC anchors, utility header, mobile menu, accessibility mode. |
| Contact | `/contact.html` | Form validation/loading/success/error. |
| Not found | any unknown GET/HEAD | True status 404, branded desktop/mobile response. |

### Authenticated documents and state families

| Role | Canonical documents | State families covered by the browser suites |
|---|---|---|
| Attorney | `dashboard-attorney.html`, `create-case.html`, `case-detail.html`, `profile-settings.html`, `profile-attorney.html`, `profile-paralegal.html`, `browse-paralegals.html`, `help.html` | Home; four Matter filters; tasks; payments; all create steps; Matter workspace tabs; invitations; profiles; settings/security/preferences; global search; notifications; Assistant; dialogs; empty/error/populated and mobile navigation states. |
| Paralegal | `dashboard-paralegal.html`, `browse-jobs.html`, `case-detail.html`, `profile-settings.html`, `profile-paralegal.html`, `profile-attorney.html`, `paralegalhelp.html` | Home; active/completed Matters; applications; invitations; availability; browse/filter/expanded/apply states; shared workspace; profile/settings; global overlays and mobile navigation. |
| Director | `director-portal.html` | Zero/populated analytics contract, truthful chart state, Zoho actions, filters, sort, selection, pagination, table empty/populated behavior, responsive layout. |
| Admin | `admin-dashboard.html`, `admin-directors.html` | Overview, users/photo review, AI Control Room, engineering, approvals, knowledge, marketing, support, sales, finance, posts, activity, settings, Director oversight, decision/dialog states, responsive navigation. |

### Entry-by-entry coverage matrix

Browser key: `C/F/W` means Chromium, Firefox, and WebKit. Viewport key: `P` means 1440×900 plus 390×844 captures and 720px reflow; `M8` means the full 360×800, 390×844, 768×1024, 1024×768, 1280×800, 1366×768, 1440×900, and 1920×1080 matrix. Public evidence paths use `backend/test-results/visual-brand-audit/{baseline|final}/public/<stem>-{1440x900|390x844}.png`. Authenticated evidence uses the corresponding named files and role/state bundles under `baseline/` and `final/authenticated/`. Redirect entries intentionally reuse their canonical target evidence because the compatibility document has no independent visual state.

| Entry / route | Role | States reviewed | Viewports | Browsers | Baseline → final evidence | Status |
|---|---|---|---|---|---|---|
| `index.html` `/` | Public | Guest/member nav, workflow chapters, both Assistant previews, both role paths, reduced motion | P | C/F/W | `public/home-*` → `public/home-*` | Verified |
| `login.html` | Public/auth | Password, Google, passkey, 2FA/backup, validation/loading/error | P | C/F/W | `public/login-*` → `public/login-*` | Verified |
| `signup.html` | Public/auth | Role selection, attorney/paralegal, Google/passkey, validation, Turnstile boundary | P | C/F/W | `public/signup-*` → `public/signup-*` | Verified |
| `forgot-password.html` | Public/auth | Validation, loading, generic confirmation, error | P | C/F/W | `public/forgot-password-*` → same stem | Verified |
| `reset-password.html` | Public/auth | Missing/invalid/expired token, validation, loading, success/error | P | C/F/W | `public/reset-password-*` → same stem | Verified |
| `verify-email.html` | Public/auth | Missing/invalid/expired token, loading, success/error | P | C/F/W | `public/verify-email-*` → same stem | Verified |
| `privacy.html` | Public/legal | Long content, headings, links, mobile reflow | P | C/F/W | `public/privacy-*` → same stem | Verified; hash unchanged |
| `terms.html` | Public/legal | Long content, headings, anchors, mobile reflow | P | C/F/W | `public/terms-*` → same stem | Verified; hash unchanged |
| `accessibility.html` | Public/legal | Content, utility navigation, focus, reflow | P | C/F/W | `public/accessibility-statement-*` → same stem | Verified |
| `contact.html` | Public | Form validation, loading, success/error, focus | P | C/F/W | `public/contact-*` → same stem | Verified |
| `paralegal-admission.html` | Public | Long content, CTA, focus, reflow | P | C/F/W | `public/paralegal-admission-*` → same stem | Verified |
| `attorney-faq.html` | Public | TOC, anchors, long content, CTA | P | C/F/W | `public/attorney-FAQ-*` → same stem | Verified |
| `paralegal-faq.html` | Public | TOC, anchors, long content, CTA | P | C/F/W | `public/paralegal-FAQ-*` → same stem | Verified |
| `404.html` / unknown route | Public | True 404 status, desktop/mobile response | P | C/F/W | `public/not-found-*` → same stem | Verified |
| `browse-paralegals.html` | Guest/attorney | Loading/populated/empty/error, filters, pagination, fallback photo, mobile filter/dialogs | P + M8 | C/F/W | `public/browse-paralegals-*`, `lpc-auth-browse-*` → same stems | Verified |
| `dashboard-attorney.html` | Attorney | Home, four Matter filters, tasks, payments, search, notifications, Assistant, mobile nav | M8 | C/F/W | `lpc-prompt1-attorney-*`, `lpc-attorney-dashboard-*` → `authenticated/lpc-attorney-*` | Verified |
| `create-case.html` | Attorney | All steps, validation, preview, edit and attachment states | M8 | C/F/W | attorney state bundle → `authenticated/lpc-attorney-*` plus browser trace | Verified |
| `case-detail.html` | Attorney/paralegal | Overview, work, messages, files, financials, applications, activity, empty/error/populated | M8 | C/F/W | `lpc-prompt2-*`, `lpc-prompt5-*` → authenticated role bundle plus browser trace | Verified |
| `profile-settings.html` | Attorney/paralegal | Profile, security, payment/payout, preferences, themes, validation/dialogs | M8 | C/F/W | authenticated role bundle → authenticated role bundle plus browser trace | Verified |
| `profile-attorney.html` | Attorney/paralegal | Real record, fallback image, metadata/actions | M8 | C/F/W | authenticated profile bundle → authenticated role bundle plus browser trace | Verified |
| `profile-paralegal.html` | Attorney/paralegal | Real record, invite/hire dialog, fee disclosure, fallback image | M8 | C/F/W | `lpc-auth-browse-*` → `authenticated/lpc-auth-browse-*` plus browser trace | Verified |
| `help.html` | Attorney | Help navigation, incident intake, Assistant | M8 | C/F/W | attorney state bundle → `authenticated/lpc-attorney-assistant-*` | Verified |
| `dashboard-paralegal.html` | Paralegal | Home, active/completed Matters, applications, invitations, availability, overlays/nav | M8 | C/F/W | `lpc-prompt1-paralegal-*`, `lpc-paralegal-dashboard-*` → `authenticated/lpc-paralegal-*` | Verified |
| `browse-jobs.html` | Paralegal | Filter/list/expanded/apply, empty/error/populated | M8 | C/F/W | `lpc-prompt5-paralegal-browse-*` → paralegal authenticated bundle plus browser trace | Verified |
| `paralegalhelp.html` | Paralegal | Help navigation, Assistant and incident intake | M8 | C/F/W | paralegal state bundle → `authenticated/lpc-paralegal-assistant-*` | Verified |
| `director-portal.html` | Director | Zero/populated analytics, filters/sort/selection/pagination, Zoho actions | M8 | C/F/W | `lpc-director-portal-*` → `authenticated/lpc-director-portal-*` | Verified |
| `admin-dashboard.html` | Admin | All 14 operational sections, decisions/dialogs, loading/error/populated, responsive nav | M8 | C/F/W | `lpc-admin-*-desktop`, `lpc-control-room-*` → matching `authenticated/` files | Verified |
| `admin-directors.html` | Admin | Director oversight table, empty/populated, actions | M8 | C/F/W | admin state bundle → authenticated admin bundle plus browser trace | Verified |
| `active-cases.html` | Attorney compatibility | Query/hash preservation to dashboard Matters | M8 | C/F/W | canonical attorney dashboard evidence | Verified redirect |
| `billing-attorney.html` | Attorney compatibility | Query/hash preservation to payments | M8 | C/F/W | canonical attorney payments evidence | Verified redirect |
| `case-applications.html` | Attorney compatibility | Matter/application context preservation | M8 | C/F/W | canonical attorney Matter evidence | Verified redirect |
| `create-case-step2.html` | Attorney compatibility | Step context preservation | M8 | C/F/W | canonical create-Matter evidence | Verified redirect |
| `create-case-step5.html` | Attorney compatibility | Step context preservation | M8 | C/F/W | canonical create-Matter evidence | Verified redirect |
| `paralegal-applications.html` | Paralegal compatibility | Application context preservation | M8 | C/F/W | canonical paralegal Matters evidence | Verified redirect |
| `paralegal-assigned.html` | Paralegal compatibility | Assigned Matter context preservation | M8 | C/F/W | canonical paralegal Matters evidence | Verified redirect |
| `paralegal-invitations.html` | Paralegal compatibility | Invitation context preservation | M8 | C/F/W | canonical paralegal dashboard evidence | Verified redirect |

Private profiles remain private. The visual remediation does not alter authentication or route authorization.

### Compatibility routes retained

The following are intentional bookmark, email, and payment compatibility surfaces: `active-cases.html`, `billing-attorney.html`, `case-applications.html`, `create-case-step2.html`, `create-case-step5.html`, `paralegal-applications.html`, `paralegal-assigned.html`, and `paralegal-invitations.html`. They retain context and converge on canonical routes. Removal requires production telemetry and external-link ownership evidence.

### Required viewport matrix

The shared Playwright matrix now covers:

- 360×800 compact mobile
- 390×844 mobile
- 768×1024 tablet
- 1024×768 compact desktop
- 1280×800 desktop
- 1366×768 legacy supported laptop
- 1440×900 audit desktop
- 1920×1080 wide desktop

Critical suites run Chromium, Firefox, and WebKit. Public evidence capture runs deterministic Chromium screenshots at 1440×900 and 390×844 for every public route, with 720px reflow as the 200%-equivalent check. Keyboard focus, reduced motion, horizontal overflow, font readiness, natural image dimensions, zero-size rendered graphics, persistent loader copy, visual-resource failures, and WCAG A/AA checks are automated where deterministic.

Ignored, owner-only evidence is organized under:

- `backend/test-results/visual-brand-audit/baseline/`
- `backend/test-results/visual-brand-audit/final/`

The evidence is deliberately untracked because it contains authenticated test records and operational UI.

## Issue register and remediation

Nineteen confirmed issues were found and all nineteen were fixed: 0 Critical, 8 High, 10 Medium, and 1 Low. There is no unresolved confirmed visual defect in the reachable local production surface.

| ID | Severity | Confirmed problem | Root cause | Remediation | Regression protection |
|---|---|---|---|---|---|
| VA-001 | High | Ten authenticated surfaces were flattened into generic gray/white/purple UI. | Late `product-clean.css` universal `!important` reset introduced in broad remediation. | Preserved structural fixes; restored Cormorant hierarchy, LPC ink/gold/cream roles, 14px panels, 6px controls, selected-state bar, accessible dark tokens, and page-theme compatibility. | Retired-token and bundled-weight policy; cross-role Playwright suites and eight-size matrix. |
| VA-002 | High | Desktop signup wordmark was visibly clipped/obscured. | Wordmark z-index 20 sat behind the left panel at z-index 1000. | Raised the wordmark into the correct local stacking order. | Browser assertion checks bounds and center-point occlusion. |
| VA-003 | High | Director zero state displayed hard-coded trend paths, static bars/dots, and upward arrows. | Placeholder graphics were left in production markup and the renderer plotted zero-value polylines. | Removed hard-coded paths and hidden summary row; chart now binds Registered/Follow-Ups/Completed series, exposes a truthful empty state, and hides zero-data gauges/dots/bars. | Director browser test requires empty-state copy/classes and zero polylines when metrics are zero. |
| VA-004 | High | White normal text on public/admin decorative gold failed contrast. | Decorative gold was used as an action background without changing foreground role. | Public gold uses dark ink; admin primary controls use dark ink; interactive dark gold remains available for white text. | Axe checks on public/admin/critical surfaces. |
| VA-005 | High | Notifications visually copied Stripe purple and dark colors. | A late copied skin owned the cascade. | Kept the dense popover behavior; replaced palette, radius, shadow, unread marker, dark layer, and touch actions with LPC roles. | Hygiene rejects retired purple tokens; browser interaction and Axe tests remain. |
| VA-006 | High | Assistant had three competing skins, unloaded DM Serif, system fonts, blue actions, and undersized controls. | Append-only redesign layers. | Removed the final generic blue/system layer; retained one LPC premium layer plus one dark override; normalized fonts, focus, links, controls, and mobile hit targets. | Retired-token/font policy plus attorney/paralegal Assistant browser flows. |
| VA-007 | Medium | Directory filter explicitly used Stripe styling, purple state, and 28–34px controls. | Page-local copied skin. | Replaced with LPC gold/navy/neutral tokens, Cormorant heading hierarchy, 40px desktop and 44px mobile targets. | Critical route Axe/overflow checks and visual capture. |
| VA-008 | Medium | Attorney/paralegal profile actions used undocumented generic blue. | Uncoordinated page-local role palettes. | Mapped profile and settings actions to interactive gold, including dark-mode gold. | Hygiene rejects the retired blue token family. |
| VA-009 | Medium | Unsubscribe used a disconnected gray/green/yellow identity, pill control, and empty stylesheet link. | One-off utility page implementation. | Rebuilt its styling on public LPC tokens, wordmark, type roles, control geometry, mobile target, and high-contrast action; removed empty link. | Every public route now receives screenshot, resource, font, image, reflow, and Axe checks. |
| VA-010 | Medium | Active CSS requested nine unavailable numeric weights. | Local font migration did not normalize old weight requests. | Normalized active requests to the bundled weight set and corrected Cormorant’s serif fallback. | Hygiene fails on unavailable numeric weights and a sans fallback for the display face. |
| VA-011 | Medium | Avatar fallback SVGs were duplicated with inconsistent fonts, colors, shapes, and missing viewBoxes. | Component logic generated independent data SVGs. | Consolidated generic fallbacks on `assets/avatar-placeholder.svg`; retained DOM initials where text identity is intentional. | Local asset reachability and browser natural-dimension checks. |
| VA-012 | Medium | Shared header, filter, notification, Assistant, fee-help, and sidebar-grip targets fell below enterprise mobile sizing; grip focus was not visible. | Compact desktop values leaked into touch layout. | Enforced 44px mobile targets and visible LPC focus rings; grip now uses brand gold instead of blue-gray. | Viewport matrix and deterministic focus traversal. |
| VA-013 | Medium | Shared theme variables could reduce muted text below AA in mountain-light mode. | Inline/session theme variables overrode the shared shell. | Introduced an accessible product-muted value with protected precedence and dark-mode override. | Axe across actual authenticated records caught and now guards the defect. |
| VA-014 | Medium | Admin headings were forced to generic sans and used unsupported medium weight. | Late operational override erased identity hierarchy. | Restored Cormorant heading/card-title role and supported 600 control weight without changing dense operational metrics. | Admin/control-room Axe and screenshots. |
| VA-015 | Medium | Browser/asset hygiene omitted CSS URLs, `srcset`, remote visual assets, bare `confirm`/`prompt`, and token/font drift. | Static policy only parsed basic HTML attributes and a narrow placeholder list. | Added CSS URL and `srcset` resolution, mutable remote visual checks, all native-dialog spellings, retired-token/fallback guard, and weight inventory. | Focused policy tests plus `check:frontend`. |
| VA-016 | Low | Three dashboard-preview SVGs had no production consumer; a hidden Director summary duplicated visible metrics. | Retired presentation branches remained tracked. | Removed only the confirmed orphaned SVGs and hidden summary branch. | Reachable stylesheet/script/asset checks; route coverage confirms no consumer. |
| VA-017 | High | AI Control Room’s CMO card could remain behind a loader for 15–18 seconds on a cold aggregate. | The summary path requested the full publishing overview and the client independently re-requested Founder focus. | Added a read-only grouped status-count aggregate, embedded the atomic Founder view in the summary, and removed the duplicate client request. Cold CMO rendering is now 2.2–2.6 seconds. | Focused service/route tests and 63/63 Control Room journeys. |
| VA-018 | Medium | Adversarial review found residual generic slate tokens, two FAQ display headings with a sans fallback/unavailable weight, and 26px fee-help targets. | Page-local remnants were outside the first retired-token list. | Mapped the remnants to LPC muted roles, corrected Cormorant to 300/serif, raised fee-help controls to 40px desktop/44px mobile, and expanded policy coverage. | 21 focused hygiene tests, full frontend hygiene, public three-engine suite, and cross-role browser contracts. |
| VA-019 | High | The final public-directory capture remained on “Loading paralegals…”; all three engines rejected imported `.mjs` modules in the dedicated audit server, and the login pass did not see the missing WebAuthn vendor script because scripts were outside its resource check. | The accessibility fixture server omitted `.mjs` and the production-mapped WebAuthn bundle from its MIME/route map, while the loader detector only recognized bare “Loading.” Production Express resolves both, but the audit server did not faithfully reproduce it. | Added executable `.mjs` MIME handling and the WebAuthn vendor mapping to the audit server, made the production `.mjs` header explicit, expanded resource checks to scripts, broadened loader detection, and required settled truthful state before capture. | Static-header unit test, focused and full C/F/W public reruns, regenerated desktop/mobile images, script network checks, and manual image inspection. |

### Issue scope, files, evidence, and closure

Every row below is closed. Browser evidence is C/F/W unless a screenshot is named; named screenshots are deterministic Chromium captures and the same state was structurally exercised in Firefox and WebKit.

| ID | Page/component, role/state, impact/rule | Exact production files changed | Before → after evidence |
|---|---|---|---|
| VA-001 | Authenticated shell; all roles/themes; brand recognition and hierarchy | `frontend/assets/styles/product-clean.css`; `create-case.html`, `case-detail.html`, `browse-paralegals.html`, `browse-jobs.html`, `help.html`, `paralegalhelp.html`, `profile-paralegal.html`, `profile-settings.html`, `dashboard-attorney.html`, `dashboard-paralegal.html` | `baseline/lpc-prompt1-*`, `lpc-prompt2-*`, `lpc-prompt5-*` → `final/authenticated/lpc-*-dashboard-*`, browse, Assistant, and suite traces |
| VA-002 | Signup desktop; wordmark clipping harmed identity/trust | `frontend/signup.html` | `baseline/public/signup-1440x900.png` → `final/public/signup-1440x900.png` |
| VA-003 | Director zero/populated analytics; fake trends harmed data truth | `frontend/director-portal.html`, `frontend/assets/scripts/director-portal.js` | `baseline/lpc-director-portal-*` → `final/authenticated/lpc-director-portal-*` |
| VA-004 | Public/admin primary actions; WCAG contrast | `frontend/assets/styles/homepage.css`, `frontend/admin-dashboard.html`, `frontend/admin-directors.html`, directory/profile action styles | affected baseline public/admin images → matching final images |
| VA-005 | Notifications; attorney/paralegal, unread/open/dark/mobile | `frontend/assets/styles/notifications-dashboard.css`, `frontend/assets/scripts/utils/notifications.js` | role dashboard/search images → final authenticated role images and browser traces |
| VA-006 | Assistant; attorney/paralegal open/closed/loading/conversation/error/dark/mobile | `frontend/assets/styles/support-drawer.css`; support Playwright specs | dashboard baseline → `final/authenticated/lpc-*-assistant-{chromium|firefox|webkit}.png` |
| VA-007 | Directory; guest/attorney filters and dialogs; brand/touch usability | `frontend/browse-paralegals.html`, `frontend/assets/scripts/browse-paralegals.js` | `baseline/public/browse-paralegals-*`, `baseline/lpc-auth-browse-*` → matching final paths |
| VA-008 | Profiles/settings; attorney/paralegal action hierarchy | `frontend/profile-attorney.html`, `frontend/profile-paralegal.html`, `frontend/profile-settings.html`, `frontend/assets/styles/profile-paralegal.css` | authenticated baseline profile/browse bundle → final authenticated browse/profile traces |
| VA-010 | Repo-wide active type; rendering consistency | affected HTML/CSS/JS-injected CSS plus `backend/scripts/check-frontend-hygiene.js` | baseline route set → final route set; local font/resource assertions |
| VA-011 | Avatar fallbacks; browse/profile/header/cards | `frontend/assets/avatar-placeholder.svg`; avatar consumers in attorney, paralegal, browse, profile, notifications scripts | baseline role/profile set → final authenticated browse/role set |
| VA-012 | Shared controls; keyboard/touch/focus at mobile sizes | `universal-header.css`, `sidebar-grip.css`, `product-clean.css`, `support-drawer.css`, profile/attorney hire-dialog scripts | mobile baseline route set → mobile final route set plus eight-size checks |
| VA-013 | Mountain-light/dark muted text; authenticated WCAG | `frontend/assets/styles/product-clean.css` and affected page token declarations | themed role baseline → final role/browser traces |
| VA-014 | Admin headings/actions; operational hierarchy | `frontend/admin-dashboard.html`, `frontend/assets/styles/admin-ai-control-room.css` | `baseline/lpc-admin-*`, `lpc-control-room-*` → matching `final/authenticated/` files |
| VA-015 | Static visual policy; prevents reintroduction | `backend/scripts/check-frontend-hygiene.js`, `backend/tests/frontendHygienePolicy.test.js`, public Playwright spec | gate absent → 21 focused tests and 38-entry asset graph passing |
| VA-016 | Orphan art/duplicate Director branch; maintenance and truthful output | deleted `frontend/assets/images/dashboard-preview-{admin,attorney,paralegal}.svg`; Director HTML/script | asset graph and Director baseline → clean asset graph and truthful final Director images |
| VA-017 | Control Room cold-load CMO/Founder state; time-to-usable | `backend/services/marketing/publishingCycleService.js`, `backend/routes/aiAdmin.js`, `frontend/assets/scripts/admin-dashboard.js` | 15–18s observed cold load → 2.2–2.6s observed cold load; final Control Room images |
| VA-018 | FAQ headings, neutral token remnants, fee-help buttons; consistency/touch | FAQ, auth/directory styles, `dialogs.css`, `global-search.css`, `matter-work-queue.css`, `product-clean.css`, `attorney-tabs.js`, `profile-paralegal.js` | adversarial source scan and public baseline → final public/authenticated captures and clean policy scan |
| VA-019 | Public directory/login evidence and imported browser modules; loader-obscured evidence exposed cross-browser audit-server fidelity failures | `backend/scripts/serve-frontend-accessibility.js`, `backend/utils/staticCache.js`, `backend/tests/staticCache.test.js`, `backend/tests/playwright/accessibility/public-pages.spec.js` | `baseline/public/browse-paralegals-*` and rejected first final capture → executable module/vendor responses plus regenerated `final/public/browse-paralegals-*` truthful empty state |

## Consolidation record and ownership map

| Required consolidation record | Completed result |
|---|---|
| Hard-coded fonts replaced | Removed active DM Serif, Segoe/system UI skinning, incorrect Cormorant sans fallback, and unsupported numeric requests; restored Cormorant display and Sarabun interface ownership. |
| Hard-coded colors replaced | Removed retired Stripe-purple, generic action-blue, generic slate-muted, and white-on-decorative-gold uses from non-Director production UI; mapped them to LPC ink, muted, gold, and semantic roles. |
| Duplicate tokens/layers removed | Removed the late universal product reset’s competing visual vocabulary and the final Assistant “quiet luxury” system-font/blue layer while retaining their valid structural behavior. |
| Dead visual branches removed | Deleted three proven-orphan dashboard-preview SVGs and the hidden Director summary/placeholder visualization branch. |
| Broken assets repaired or removed | Consolidated generic avatars on `assets/avatar-placeholder.svg`; made audit module/vendor delivery faithful; preserved `Cleanfav.png` because backend emails and receipts consume it. |
| Shared components normalized | Product shell, universal header, sidebar grip, dialogs, notifications, global search, Assistant, directory controls, profile actions, and mobile targets now share LPC roles. |
| Page-local overrides retained | Public editorial pacing, legal document structure, admin density, theme variants, and Director chart colors remain local because their purpose differs from the base product shell. |
| Intentional role differences | Attorney/paralegal workflow labels and density, admin operational hierarchy, Director data series, and user-owned dark/mountain themes remain distinct without introducing a second brand. |

| Concern | Owner after remediation |
|---|---|
| Public editorial system | `assets/styles/homepage.css` plus shared public/legal styles. |
| Authenticated product shell | `assets/styles/product-clean.css`, with shared tokens and explicit dark override. |
| Cross-product base tokens | `assets/styles/dashboard-system.css` and product-shell mappings. |
| Header/navigation geometry | `universal-header.css`, `sidebar-grip.css`, and product shell. |
| Notifications | `notifications-dashboard.css`; no third-party visual vocabulary. |
| Assistant | One premium LPC layer and one dark override in `support-drawer.css`. |
| Profiles | Shared product roles plus `profile-paralegal.css`; attorney-local actions map to the same interactive gold. |
| Avatar fallback | `assets/avatar-placeholder.svg`. |
| Director visualization | Director-local palette and API-bound renderer. |
| Admin/control room | Admin-local operational layout with shared LPC typography and semantic state colors. |

## Deliberate exceptions and retained candidates

- Director’s blue/rose/purple chart series remain role-scoped because they distinguish actual data series. They must not be reused for global actions or selected navigation.
- Danger, success, warning, focus, unread, and disabled colors are semantic. Visual consistency does not collapse distinct meanings into gold.
- Dark, mountain, and mountain-dark preferences remain user-owned variants. The shared shell now preserves them instead of forcing white.
- Public storytelling retains larger spacing/radii where it supports narrative pacing; authenticated surfaces remain denser.
- Eight compatibility documents are retained. They are not dead pages.
- Inactive source branches in profile settings, legacy dashboard files, and alternate path parsing are documented candidates only. They are not removed without runtime telemetry and notification/search/deep-link tracing.
- Dynamic operational content prevents honest global pixel-golden assertions. Regression protection therefore combines deterministic screenshots, structural visual integrity, exact token/font policy, WCAG analysis, and state-specific browser contracts. Baseline/final evidence remains available for human comparison.

## Verification ledger

| Gate | Result |
|---|---|
| Focused frontend hygiene policy | Passed: 21/21. |
| Static response/cache policy | Passed: 6/6, including executable `.mjs` delivery. |
| Frontend hygiene and local asset graph | Passed: 38 HTML entry points, 422 local asset references, 62 reachable modules, 22 reachable stylesheets. |
| Frontend binding analysis | Passed: 59 scripts, no unused bindings or silent awaited catches. |
| JavaScript syntax | Passed: 581 JavaScript files parsed on the final source tree. |
| Focused/skipped-test policy | Passed: no focused or skipped tests. |
| Legal integrity | Passed: Terms SHA-256 `a7373a79e1dbc55e2192eadc73de8f4ba4793a35f59f2e50094374172c3b72ab`; Privacy SHA-256 `d5cf06d771fa50ee6852f64d226422c43a64c50ce43b3860dec8dd07704978fe`. No counsel gate created. |
| Public visual/a11y/focus/reflow/resource capture | Passed: 57/57 across Chromium, Firefox, and WebKit. |
| Attorney critical journeys | Passed: 45/45 across Chromium, Firefox, and WebKit. |
| Paralegal critical journeys | Passed: 24/24 across Chromium, Firefox, and WebKit. |
| Director critical journeys | Passed: 3/3 across Chromium, Firefox, and WebKit. |
| Admin/Control Room journeys | Passed: 63/63 across Chromium, Firefox, and WebKit. |
| Critical browser subtotal | Passed: 135/135. |
| Browser contracts | Passed in full after the canonical-avatar and heading-font contract updates. |
| Desktop/mobile performance browser suite | Passed: 8/8. Exact final run desktop LCP/CLS/transfer—home 412ms/0.0066/229.5KiB; login 168ms/0.0001/281.0KiB; signup 212ms/0.0014/261.8KiB; recovery 160ms/0.0004/561.2KiB. Mobile LCP—home 304ms, login 136ms, signup 160ms, recovery 140ms; all mobile CLS 0. |
| Static performance budget | Passed: 154 files, 4539.7KiB total; largest-raster budget 600KiB. |
| Static repository/API/security constituents | Passed: CI workflow, CODEOWNERS/Dependabot, 366 unique literal routes, 303 reachable backend modules, 380 runtime modules clean, 201 security-inventoried routes (194 verified, 7 documented exemptions, 0 open), 207 logger-owned modules, 163 frontend API literals resolving to 350 mounted patterns, vendored asset policy, secret scan, evidence permissions, and no-theater policy. |
| Payment focused suites | Passed: 55/55. |
| Authentication focused suites | Passed: 50/50. |
| End-to-end suite | Passed: 13/13. |
| Jest excluding only the runtime-gate suite | Passed on the exact final tree: 178/178 suites, 1315/1315 tests. |
| Release-candidate Jest suite on this host | 4/7 pass; the remaining 3 fail closed because the host is Node 22.17.0 while the repository requires Node `>=24.18 <25`. Combined exact-tree accounting: 178/179 suites and 1319/1322 tests pass, with no application-test failure. |
| Exact `npm audit --omit=dev --audit-level=high` | `found 0 vulnerabilities`; zero findings and therefore zero production-reachable findings. No audit fix, upgrade, install, or lockfile mutation was performed. |
| SBOM/licenses/deploy blueprint | SBOM generated locally: 227 components, 228 dependency relationships, 2 license records; 227 licenses passed; deploy blueprint passed. |
| Full `npm run release:verify` | Not runnable to a passing result before a clean immutable candidate exists; after authorization it is also required to run under Node `>=24.18 <25` and npm `11.16.0`. |

The public performance suite remained comfortably inside the existing budgets. A trustworthy pre-remediation public lab run was not retained, so this report does not invent a public LCP delta. The directly measured usability regression did have a before/after comparison: cold Control Room CMO rendering improved from 15–18 seconds to 2.2–2.6 seconds.

## Remaining external NO-GO gates

These are release-process blockers, not unresolved visual defects:

| Blocker | Why code cannot resolve it | Current safe behavior | Owner | Required next action |
|---|---|---|---|---|
| Candidate authorization | The task explicitly forbids creating the visual candidate commit without separate authorization. | All changes remain unstaged and local; no history was changed. | Repository owner | Authorize the snapshot/staging/local immutable commit procedure in a separate instruction. |
| Required release runtime | Host Node 22.17.0/npm 10.9.2 does not meet the repository requirement Node `>=24.18 <25`/npm `11.16.0`. | Runtime/lockfile/release-candidate gates fail closed; no lockfile mutation or toolchain install was attempted. | Release environment owner | Provide or select the pinned runtime, then run `check:runtime`, `check:lockfile`, and the release-candidate suite. |
| Exact release verification | `check:candidate` requires a clean committed candidate, and later constituents require the pinned runtime. | Constituent application, browser, security-audit, license, and deploy-blueprint checks are recorded above; no release claim is made. | Repository/release owner | After the two gates above, run full `npm run release:verify` on the exact candidate SHA. |

No licensed-artwork, unresolved visual, legal-copy, or external-production-evidence exception was created by this remediation.

## Candidate boundary

No candidate commit is created as part of this audit turn. The repository’s `check:candidate` correctly requires a clean immutable commit, so the exact full `npm run release:verify` can only pass after the user separately authorizes candidate creation and the pinned runtime is available. No file is staged. No push, deploy, external-service mutation, history rewrite, or environment-value change is part of this remediation.
