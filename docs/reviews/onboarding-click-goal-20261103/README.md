# Signup-to-engagement release review

Base: `3ad5b417fc2e24f782c6300354151c42599235c5` (current sign-in release). This candidate preserves that sign-in update and the original two-step signup.

## Result

Attorneys choose **Post a Matter** from the existing welcome, then build, review and explicitly publish the Matter in the existing builder. An eligible applicant's hiring review presents compensation, fees, card and consequences before one explicit **Hire and charge** action. The optional tour remains available; selecting a Matter does not claim tour completion.

Paralegals proceed to the existing résumé importer, explicitly choose Autofill, review their details, add a photo and save. A verified-ready payout return continues to Browse Matters. Eligible applicants can read a Matter and submit their letter on the same page. Existing résumé fields, saved entries, photo review, application eligibility and payout safeguards remain supported.

## Exact main-action counts

| Role | After signup | Including the original two signup actions |
| --- | ---: | ---: |
| Attorney | 8 | 10 |
| Paralegal, uploaded photo | 10 | 12 |

[Attorney action ledger](attorney-clicks.json) and [Paralegal action ledger](paralegal-clicks.json) record every counted action. Counts include verification/approval email links, email confirmation, sign-in and explicit submissions. They exclude field focus/typing, dropdown/checkbox field entry, native file selection, Stripe/card setup, optional tours, attorney candidate browsing/review, additional applications and correction/retry paths. Paralegal engagement follows attorney hiring/funding and requires no extra acceptance action. Approval waiting time is separate from clicks.

These are successful-path local UI replays with synthetic account/email/provider/assignment/funding outcomes, not real transactions or real inbox/provider acceptance. LinkedIn adds its own sign-in/consent actions; the fixed 10/12 Paralegal count uses photo upload.

## LinkedIn photo connection

The new photo action reuses the existing crop/submission contract. The server adapter binds single-use state and results to the approved account and session, limits provider response size and image decoding, allows only supported LinkedIn image hosts, and persists no OAuth tokens. A photo is uploaded for LPC approval only after explicit submission.

The action appears only when server configuration enables it. Use `LINKEDIN_PHOTO_CLIENT_ID` and `LINKEDIN_PHOTO_CLIENT_SECRET`, or the existing LinkedIn client credentials, plus `LINKEDIN_PHOTO_REDIRECT_URI`. The URI must be the actual HTTPS canonical origin followed by `/api/uploads/linkedin-photo/callback` and must be registered on the provider application. Keep existing member-sign-in and marketing callbacks unchanged. The `LinkedInPhotoImport` model declares its ten-minute TTL and unique request indexes; provision/confirm those indexes before activating the connection on hosts with automatic index creation disabled.

Live LinkedIn photo authorization/configuration was not verified or changed in this candidate. Disabled/unavailable configuration preserves the upload route. No production data, provider settings or payment was changed.

## Validation

- 57 focused onboarding browser cases passed across Chromium, Firefox and WebKit against source and against generated production assets. Six additional return-window cases passed against source and compiled assets for success/failure, real assets and popup closure; the final welcome styling and route-guard adjustment passed 18 affected reruns.
- 12 photo-import service/route security checks and five saved-profile model checks passed.
- Both exact-action journey replays passed. The original two-step signup is covered for both roles in all three browser engines.
- Production frontend build, frontend API-route contract and candidate secret scan passed locally. Required hosted CI status is reported separately on the pull request.
- Scope review excludes unrelated local pages, styles, authentication changes and résumé-field-model changes. Source is based on current main rather than the shared authoring branch.

## LPC UX review

Baseline: current released portal pages and original signup, plus the existing LPC welcome artwork and résumé-review owner. Only task entry, direct commitment and necessary recovery/availability behavior changed.

Evidence: inspected the affected rendered controls at [1440](attorney-welcome-1440.png), [390](attorney-welcome-390.png) and [320](attorney-welcome-320.png) for Attorney; [1440](paralegal-linkedin-1440.png), [390](paralegal-linkedin-390.png) and [320](paralegal-linkedin-320.png) for Paralegal. Also inspected changed controls with dark theme/enlarged text at 320px for [Attorney](attorney-welcome-dark-large-320.png) and [Paralegal](paralegal-linkedin-dark-large-320.png). Keyboard activation/focus, photo submission focus return, 44px new mobile targets, horizontal fit, optional-tour dismissal/navigation races, retained letters and uncertain-write reconciliation were checked. Long résumé content uses the existing scrollable dialog.

UX-01–03: direct necessary actions, concise choice copy and optional tour/secondary information. UX-04–08: one primary commitment per decision, current eligibility/configuration/photo state, truthful pending/uncertain results and preserved surrounding page hierarchy. UX-09: retained consent, account/session guards, draft/recovery, photo approval and actual publish/hire disclosures. UX-10: rendered review of changed controls and desktop/mobile/keyboard/theme checks above.

Exceptions: none requested. This is an implementation review of the affected controls and transitions, not owner visual approval, whole-product certification, live-provider proof or permission to deploy. Samantha retains the final deployment decision for the exact candidate.
