# LPC launch certification checklist

This checklist applies to the exact production candidate commit. A checked implementation item means the control exists in the repository; it does not substitute for production evidence. Every unchecked stop-ship item must be resolved and linked in the launch record before go-live.

The latest local evidence snapshot and current NO-GO decision are recorded in `docs/LAUNCH_CERTIFICATION_CURRENT.md`.

Owner policy clarification, October 14: Terms acceptance and Privacy acknowledgement occur at signup only. The current signup-only behavior is intended. Existing members do not need a policy-update review or acknowledgement before new work or hiring. Preserve exact signup receipts and document copies, ordinary account/work permissions and all substantive security/privacy/recovery requirements. Samantha has no counsel; appointing one is not a dependency. Bring specific unresolved policy/business decisions to her and retain her exact-document approval. Production deployment remains unauthorized.

## 0. Let's-ParaConnect product and trust acceptance

Owner direction, September 28, 2026: LPC must earn the confidence users expect from established products such as Apple, Google, OpenAI, Facebook and X. Their names are a quality reference, not evidence of LPC's readiness or a promise of uninterrupted service. Passing tests alone does not satisfy this standard. These requirements apply to the whole product: public pages, both professional roles, administration, emails, shared services and operations.

- [ ] **Recognizably LPC.** Inspect the actual candidate for consistent typography, cornflower accents, hierarchy, spacing, terminology and interaction behavior. Review dense and sparse real-world content, long names, empty states, errors and supported screen sizes. No clipping, unexplained whitespace, placeholder filler, layout jumps or inconsistent legacy presentation remains in required journeys.
- [ ] **Clear without coaching.** An attorney can understand the work, choose a paralegal, confirm costs, review delivery and resolve an issue. A paralegal can understand eligibility, pursue a Matter, complete work and understand payment. Validate the entire journey, including emails and return links; internal implementation details do not substitute for useful instructions. Copy accurately describes independent choices and LPC's actual responsibilities.
- [ ] **Actions earn trust.** Every visible control has a verified result. Saving, sending, uploading, hiring and payment confirmation accurately reflect persisted state. Slow responses, retries, refreshes, multiple tabs and interrupted sessions cannot silently discard work, duplicate consequential actions or expose another person's information. Uncertain outcomes remain explicit and recoverable.
- [ ] **Fast and accessible in practice.** Meet the existing candidate performance and accessibility gates on representative devices, connections and data volumes. Inspect keyboard use, focus, zoom, touch targets, loading feedback and reduced motion. Test results are supplemented by direct visual and interaction review.
- [ ] **Trust survives a failure.** Verify monitoring, actionable owner alerts, provider interruption handling, durable background work, reconciliation, backup restoration and rollback on production-like infrastructure. Record measurable service objectives and recovery limits with evidence; do not substitute an aspiration of zero outages for these controls.
- [ ] **Release claims are earned.** Finish implementation across LPC, then verify one frozen candidate end to end. Retain failures and distinguish focused local checks from complete candidate, device, provider and production evidence. All existing stop-ship gates still apply. No launch shortcut is justified by schedule pressure or an impressive aggregate test count.

The implementation owner is responsible for finding and correcting inconsistencies across related surfaces, presenting concrete reviewable results, and keeping unresolved requirements visible. Samantha should not have to discover routine defects or direct each individual polish correction.

## 1. Release identity and change control

- [x] CI validates its own trigger, permission, pinned-action, timeout, job, command, dependency-review, CodeQL, and full-history secret-scan contract.
- [x] CODEOWNERS covers the entire candidate; Dependabot monitors backend npm and GitHub Actions dependencies weekly; the candidate secret scan includes tracked and untracked nonignored files.
- [x] CI requires a clean production dependency tree with no missing, invalid, or extraneous packages; produces retained Jest/browser JUnit evidence and a CycloneDX production SBOM; requires source-backed license metadata for every production dependency under the reviewed fail-closed permissive policy; and verifies vendored browser assets have immutable provenance, byte hashes, complete licenses, and a repository gate.
- [x] `npm run check:candidate` fails closed on staged, unstaged, or untracked changes; rejects CI/checkout identity mismatch, runtime drift, and untracked/non-regular critical files; and writes an owner-only manifest with the exact commit, observed/pinned Node and npm versions, and critical release-file hashes before dependency installation.
- [ ] Record the exact Git commit, `.node-version`, lockfile digest, Samantha as final release/deployment approver, accountable operators, and planned deployment window. Her approval may cover a candidate she authored.
- [ ] Confirm `main` is protected, every required check passed on that commit, review threads are resolved, and no direct or force push bypassed the required PR/check controls. Independent reviewer, CODEOWNER and last-pusher approvals are not required; retain CODEOWNERS ownership coverage.
- [ ] Confirm whether the currently public GitHub repository is intentional. If it remains public, obtain security/legal approval that its complete source history and assets are suitable for disclosure.
- [ ] Inventory all 880 remote branches (read-only inventory refreshed October 12; previously 823), map the 818 legacy `incident/` branches to retained incident/PR evidence, scan every remote ref for secrets and unreviewed public disclosure, obtain the retention owner's decision, and remove/archive only approved stale branches with an auditable before/after record.
- [ ] Run `npm ci` from the committed lockfile and retain the CI run URL.
- [ ] Run `npm run release:verify` from `backend/` on the committed candidate and retain its evidence.
- [x] The owner-authorized command `npm audit --omit=dev --audit-level=high` completed against the production dependency graph with exit code 0 and `found 0 vulnerabilities`; it did not modify the lockfile. Protected CI must repeat the same command on the exact candidate.
- [ ] Validate `render.yaml` and record the Render Blueprint sync/deploy identifiers for the web service, incident worker, automation cron, and operations-monitor cron.
- [ ] Confirm the web, worker, automation cron, and operations-monitor runtimes each report the same full `RENDER_GIT_COMMIT` as the approved candidate; a missing, abbreviated, or mismatched value is a failed deployment.
- [ ] Name the rollback owner, rollback commit/artifact, database-migration rollback or forward-fix decision, and abort criteria.

## 2. Legal, privacy, and user acknowledgement

- [x] Terms and Privacy are distinct documents with matching version constants, visible effective dates, and exact SHA-256 release digests.
- [x] New signup separately records Terms agreement and Privacy acknowledgement with version, timestamp, and source.
- [x] AI-assisted support identifies OpenAI at point of use, prohibits confidential/privileged matter content, and is accurately described in the Privacy Policy.
- [ ] Samantha approves the exact Terms and Privacy files after the specific policy/business decisions and factual checks are resolved. Record her actual approval reference plus the hashes printed by `npm run check:legal` in the production secret store. Do not invent a counsel approval; the existing `LEGAL_COUNSEL_APPROVAL_ID` is a legacy configuration key.
- [ ] Samantha reviews the restored Privacy Policy section “Processing in the United States” after the actual hosting, processing and vendor facts are verified. Its candidate digest supersedes any earlier unapproved Privacy digest; record unresolved policy uncertainty explicitly.
- [ ] Run `npm run certify:legal`; it must confirm the recorded owner policy approval and exact document versions/digests.
- [ ] After deployment, run `npm run verify:production` from the same clean candidate checkout and retain `test-results/release/production-surface.json`; the live Terms and Privacy bytes must match the owner-approved candidate hashes.
- [ ] Samantha resolves the specific jurisdiction, privacy, marketplace, professional-responsibility, independent-contractor, fee, dispute, waiver and notice policy/business decisions after the substantive factual checks. Record any unresolved legal uncertainty; technical verification does not establish a legal opinion or require appointing counsel.

## 3. Authentication, authorization, and account security

- [x] Managed server sessions, revocation, secure cookies, CSRF, Argon2id password hashing, email verification, passkeys, TOTP, backup codes, and login rate limits are implemented.
- [x] Production configuration fails closed for missing or unsafe canonical origin, JWT issuer/audience, credentials, encryption, session, malware-scan, AI rollout, email, Stripe/webhook-alert, staging identity, or test-harness settings; recurring business work is structurally absent from the horizontally scalable HTTP process.
- [x] The Attorney Assistant has explicit externally managed rollout authority with only approved 0/10/25/50/100 stages, a required internal-stage allowlist, and disabled legacy fallback; the Paralegal upgraded manager is fixed off until a reviewed contract change.
- [ ] Record and verify the Attorney Assistant production stage, Package 9 duration/sample/incident evidence, release owner, and technical owner. Do not advance or launch a stage from a missing/default variable.
- [ ] Run the full authentication/security suite on the exact candidate and attach results.
- [ ] Manually verify password, Google, passkey, email-2FA, authenticator-2FA, backup-code, reset, logout, session-revocation, and disabled-account journeys on production-like infrastructure.
- [ ] Verify attorney, paralegal, director, admin, applicant, withdrawn-user, and unrelated-user access boundaries with representative production-like records.

## 4. Payments and financial integrity

- [x] Payment operations use durable idempotency, Stripe webhook signature verification, a pinned API version, reconciliation, immutable financial events, and lifecycle invariants.
- [ ] Confirm live Stripe and Connect keys, both webhook secrets, endpoint destinations, event subscriptions, and the pinned API version in production. Never place secret values in the launch record.
- [ ] Execute the candidate’s payment suite and retain results.
- [ ] In an authorized live-mode test, verify funding success, authentication-required, decline, cancellation, duplicate/out-of-order webhook, completion, payout, payout retry, partial/full refund, dispute, and Connect-incomplete paths.
- [ ] Reconcile LPC records, Stripe objects, balances, platform fees, payouts, refunds, and receipts for every live-mode test object; record object IDs, not credentials.
- [ ] Confirm no unresolved `PaymentOperation`, webhook, payout, dispute, or reconciliation item is aged beyond its operational threshold.

## 5. Matter lifecycle and role journeys

- [x] Domain transitions and money-sensitive invariants are centralized and covered by focused tests.
- [x] CI rejects literal frontend API targets without a mounted backend route; speculative search, profile fallback, admin email-test, and message-attachment actions have been removed rather than presented as working features.
- [x] Production-surface hygiene rejects placeholder links, native browser dialogs, query-enabled demos, fabricated demo/mock records, unfinished copy, and delayed full-screen loaders; fail-safe operational views expose null/unavailable state rather than invented values.
- [x] Isolated local browser journeys use the real product controls and mounted routes for profile persistence, Create Matter, application/invitation, invitation acceptance, hire/funding, messaging, realtime fallback, payouts, and withdrawal; Stripe behavior remains explicitly local-mock evidence until live-mode certification.
- [ ] Run the complete Jest suite, critical Playwright role journeys, UI contracts, and lifecycle/payment matrices on the candidate with no skips, flakes, focused tests, or retries hiding a defect.
- [ ] Complete attorney: signup → approval → profile → browse → create matter → fund → hire → collaborate → dispute/complete → receipt.
- [ ] Complete paralegal: signup → approval → profile → availability → apply/invitation → collaborate → completion → payout.
- [ ] Complete admin/director operational journeys with least-privilege accounts and verify every visible action performs the stated backend operation.
- [x] Verify SSE reconnect and polling fallback for messages, documents, tasks, notifications, and status changes.
- [ ] Confirm no unresolved P0/P1 correctness, money, authorization, data-loss, or misleading-action defect remains.

## 6. Files, privacy deletion, and retention

- [x] Private object storage, owned-key validation, file signatures, size/type controls, scan-state gates, signed delivery, and case-file recovery records are implemented.
- [x] Replaced/cleared personal profile objects use a durable deletion queue with transactional hold/reconciliation, last-moment bucket/owner/live-reference validation, retry/backoff, stale-lock recovery, blocked-state monitoring, and short-lived deletion receipts.
- [ ] Prove GuardDuty Malware Protection is active for every production upload prefix, clean tagging is enabled, and bucket/IAM policy denies reads without `NO_THREATS_FOUND`.
- [ ] Run clean, missing-tag, pending, threat, unsupported, access-denied, and failed-scan canaries. Attach evidence without uploading real personal or client data.
- [ ] Replace and clear each personal-file type in a production-like account; prove the old object becomes unreferenced, the deletion task completes, and no live reference is deleted.
- [ ] Confirm no held/pending/processing deletion task is stuck beyond 15 minutes and no retrying task has three or more failures.
- [ ] Samantha approves retention schedules, deactivation behavior, preservation decisions, financial/audit record preservation and backup expiry after the factual and privacy checks. Record any unresolved legal uncertainty; do not claim an automated litigation hold or counsel review that does not exist.

## 7. Accessibility, responsive UX, and performance

- [x] Core public, attorney, paralegal, and admin surfaces have automated accessibility coverage and keyboard-safe dialog behavior.
- [x] Unknown document routes return a branded, accessible, no-store/noindex HTTP 404 instead of a homepage soft-404; only the nine sitemap documents are indexable, and new HTML files default to `noindex, nofollow` at delivery.
- [x] Performance budgets, first-party Core Web Vitals collection, lazy Stripe loading, and licensed, versioned, byte-verified local UI dependencies are implemented.
- [x] The profile-photo editor has desktop/mobile interaction coverage for upload, keyboard repositioning, zoom, crop output, dialog semantics, overflow, and a scoped automated accessibility audit.
- [x] Confirmations, destructive prompts, and alerts share one semantic dialog system with focus trapping/restoration, Escape handling, safe text rendering, destructive-action defaults, queueing, mobile reflow, and reduced-motion support.
- [x] Browser visual fixtures render the real app shell without suppressing a current loading overlay; mobile contracts protect the header/sidebar toggle from overlap.
- [x] Browser and viewport support is explicitly defined in `docs/BROWSER_SUPPORT.md`; automated accessibility and authenticated critical-role suites run against the lockfile-pinned Chromium, Firefox, and WebKit engines, and critical surfaces share mobile, tablet, laptop, and wide-desktop regression widths.
- [ ] Run accessibility and critical-role Playwright suites on the exact candidate, plus manual real-browser/device, keyboard, screen-reader smoke, zoom/reflow, contrast, reduced-motion, error-identification, and focus-order checks.
- [ ] Verify all critical journeys at supported mobile, tablet, laptop, and wide-desktop widths with no clipped controls, horizontal overflow, hidden actions, or hover-only functionality.
- [ ] Pass synthetic performance budgets on the candidate. Treat the 28-day p75 field-vitals gate as provisional until representative production data exists; do not label synthetic data as field compliance.

## 8. Production operations and recovery

Local verification update, October 12, 2026: production and billing remain unchanged. Render bandwidth allowance is exhausted; no deploy, hosted probe, new service or provider purchase is authorized. Passed local checks are retained and are not repeated without an affecting change.

- [x] **Local email delivery complete.** The owner-designated controlled recipient was `admin@lets-paraconnect.com`. Existing Zoho Mail Free SMTP accepted three isolated local delivery checks; the owner confirmed one Inbox receipt for each at 7:03:11, 7:03:25 and 7:03:31 p.m. Eastern on October 12, with correct test marker/content, no duplicates and no preference-disabled mail. Preference suppression, delivery-time revalidation, retry/backoff and duplicate prevention are locally verified. Evidence: [local email results](output/local-zoho-email-20261012/RESULTS.txt). No further local email rerun is required unless an affecting change is made.
- [ ] **BLOCKED — deployed email-link actions.** Requires an owner-authorized deployed staging environment with a verified no-additional-charge budget, isolated accounts/data and hosted origin; then test received-link login handoff, correct record/action and access boundaries. Local SMTP/Inbox completion does not close this item.
- [ ] **BLOCKED — hosted communication-worker behavior.** Requires an owner-authorized existing staging worker/target indexes and database, with no incremental charges; then verify supervision, scheduling, release identity, restart/recovery, heartbeats and admin review/retry. Do not create a billable worker or modify production to obtain this evidence.

- [x] The Render blueprint defines separate web, incident worker, communication worker, five-minute automation, and five-minute operations-monitor services.
- [x] Withdrawal expiry, overdue-dispute notification, archive purge, director mail/follow-up, monitoring, and marketing cycles have one supervised cron owner; incident work has one dedicated runner with atomic lease renewal; route imports and the web entrypoint start no business timers.
- [x] Operations monitoring covers bounded health checks, Atlas backup freshness, Stripe webhook/reconciliation and persistent financial-exception state, file security, archive recovery, and personal-storage deletion; alert state is acknowledged only after mail transport acceptance.
- [x] Render services fail closed without a full release commit; web responses expose `X-LPC-Release-Commit`, worker/cron output records it, and the operations monitor treats web-versus-monitor commit drift as unhealthy.
- [ ] Provision and confirm all five services run the approved commit; capture the web release header and health, both worker heartbeats, and successful cron executions. The October 7 read-only Render inventory found the active web service but none of the four required background services in the current workspace.
- [ ] Run `npm run verify:production` after Render reports the deploy complete. It must prove exact candidate bytes for `/`, the branded 404 document, `/terms.html`, `/privacy.html`, `/robots.txt`, and `/sitemap.xml`; correct 200/404 statuses, HTML/text/XML content types and cache policy; candidate CSP/security headers; and no soft-404 or discovery-file fallback to the homepage.
- [ ] Confirm Atlas continuous/scheduled backup is enabled and the newest completed snapshot is within the configured threshold.
- [ ] Restore the newest snapshot into an isolated non-production cluster, verify representative users, matters, indexes, payment ledgers, and audit records, record RPO/RTO, then destroy the isolated restore.
- [ ] Trigger a controlled monitor failure and recovery; prove one owner alert and one recovery notice arrive without five-minute alert flooding.
- [ ] Confirm Render deploy failure, cron failure, worker restart, uptime, 5xx, payment-webhook, backup, file-security, and deletion-queue alerts reach the named on-call owner.
- [ ] Exercise rollback on production-like infrastructure and prove health, schema compatibility, and critical reads after rollback or forward-fix.

## 9. Final go/no-go record

- [ ] Product owner signs the critical attorney, paralegal, admin, and support journeys.
- [ ] Samantha reviews substantive engineering/security reviews, test, data integrity, deployment, observability and rollback evidence. Record the technical executor; no independent technical reviewer or second-person signature is required.
- [ ] Operations owner signs backup/restore, alerts, incident response, and on-call readiness.
- [ ] Finance owner signs live Stripe reconciliation and payout/refund evidence.
- [ ] Samantha approves the exact legal documents and launch-relevant policy/privacy decisions, with document versions, hashes and her actual approval reference recorded.
- [ ] Samantha retains final release approval: review every stop-ship condition in `docs/RELEASE_GATES.md`, record residual non-blocking risks with owner/date, and make the exact-candidate go/no-go decision. Completing this checklist does not authorize deployment without her explicit approval.

Launch remains **no-go** until every required item above is supported by evidence for the exact candidate. Local implementation and tests are necessary, but they are not production attestation.
