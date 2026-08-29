# LPC launch certification checklist

This checklist applies to the exact production candidate commit. A checked implementation item means the control exists in the repository; it does not substitute for production evidence. Every unchecked stop-ship item must be resolved and linked in the launch record before go-live.

The latest local evidence snapshot and current NO-GO decision are recorded in `docs/LAUNCH_CERTIFICATION_CURRENT.md`.

## 1. Release identity and change control

- [x] CI validates its own trigger, permission, pinned-action, timeout, job, command, dependency-review, CodeQL, and full-history secret-scan contract.
- [x] CODEOWNERS covers the entire candidate; Dependabot monitors backend npm and GitHub Actions dependencies weekly; the candidate secret scan includes tracked and untracked nonignored files.
- [x] CI requires a clean production dependency tree with no missing, invalid, or extraneous packages; produces retained Jest/browser JUnit evidence and a CycloneDX production SBOM; requires source-backed license metadata for every production dependency under the reviewed fail-closed permissive policy; and verifies vendored browser assets have immutable provenance, byte hashes, complete licenses, and a repository gate.
- [x] `npm run check:candidate` fails closed on staged, unstaged, or untracked changes; rejects CI/checkout identity mismatch, runtime drift, and untracked/non-regular critical files; and writes an owner-only manifest with the exact commit, observed/pinned Node and npm versions, and critical release-file hashes before dependency installation.
- [ ] Record the exact Git commit, `.node-version`, lockfile digest, release owner, deploy approver, and planned deployment window.
- [ ] Confirm `main` is protected, every required check passed on that commit, a code owner other than the candidate author approved it, review threads are resolved, and no direct or force push bypassed review.
- [ ] Confirm whether the currently public GitHub repository is intentional. If it remains public, obtain security/legal approval that its complete source history and assets are suitable for disclosure.
- [ ] Inventory all 823 remote branches, map the 818 legacy `incident/` branches to retained incident/PR evidence, scan every remote ref for secrets and unreviewed public disclosure, obtain the retention owner's decision, and remove/archive only approved stale branches with an auditable before/after record.
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
- [ ] Named qualified counsel approves the exact Terms and Privacy files. Record the approval reference plus the hashes printed by `npm run check:legal` in the production secret store.
- [ ] Run `npm run certify:legal`; it must confirm the counsel record and document digests.
- [ ] After deployment, run `npm run verify:production` from the same clean candidate checkout and retain `test-results/release/production-surface.json`; the live Terms and Privacy bytes must match the counsel-approved candidate hashes.
- [ ] Counsel confirms jurisdiction-specific privacy, marketplace, professional-responsibility, independent-contractor, fee, dispute, waiver, and notice language. Code review is not legal approval.

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
- [ ] Confirm retention schedules, deactivation behavior, legal holds, financial/audit record preservation, and backup expiry are approved by counsel and the data owner.

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

- [x] Web, incident worker, five-minute automation, and five-minute operations monitor have separate supervised Render services.
- [x] Withdrawal expiry, overdue-dispute notification, archive purge, director mail/follow-up, monitoring, and marketing cycles have one supervised cron owner; incident work has one dedicated runner with atomic lease renewal; route imports and the web entrypoint start no business timers.
- [x] Operations monitoring covers bounded health checks, Atlas backup freshness, Stripe webhook/reconciliation and persistent financial-exception state, file security, archive recovery, and personal-storage deletion; alert state is acknowledged only after mail transport acceptance.
- [x] Render services fail closed without a full release commit; web responses expose `X-LPC-Release-Commit`, worker/cron output records it, and the operations monitor treats web-versus-monitor commit drift as unhealthy.
- [ ] Confirm all four services run the approved commit; capture the web release header and health, worker heartbeat, and successful cron executions.
- [ ] Run `npm run verify:production` after Render reports the deploy complete. It must prove exact candidate bytes for `/`, the branded 404 document, `/terms.html`, `/privacy.html`, `/robots.txt`, and `/sitemap.xml`; correct 200/404 statuses, HTML/text/XML content types and cache policy; candidate CSP/security headers; and no soft-404 or discovery-file fallback to the homepage.
- [ ] Confirm Atlas continuous/scheduled backup is enabled and the newest completed snapshot is within the configured threshold.
- [ ] Restore the newest snapshot into an isolated non-production cluster, verify representative users, matters, indexes, payment ledgers, and audit records, record RPO/RTO, then destroy the isolated restore.
- [ ] Trigger a controlled monitor failure and recovery; prove one owner alert and one recovery notice arrive without five-minute alert flooding.
- [ ] Confirm Render deploy failure, cron failure, worker restart, uptime, 5xx, payment-webhook, backup, file-security, and deletion-queue alerts reach the named on-call owner.
- [ ] Exercise rollback on production-like infrastructure and prove health, schema compatibility, and critical reads after rollback or forward-fix.

## 9. Final go/no-go record

- [ ] Product owner signs the critical attorney, paralegal, admin, and support journeys.
- [ ] Engineering owner signs test, security, data integrity, deployment, observability, and rollback evidence.
- [ ] Operations owner signs backup/restore, alerts, incident response, and on-call readiness.
- [ ] Finance owner signs live Stripe reconciliation and payout/refund evidence.
- [ ] Counsel signs the exact legal documents and launch-relevant legal/privacy decisions.
- [ ] Release owner reviews every stop-ship condition in `docs/RELEASE_GATES.md`, records residual non-blocking risks with owner/date, and makes the final go/no-go decision.

Launch remains **no-go** until every required item above is supported by evidence for the exact candidate. Local implementation and tests are necessary, but they are not production attestation.
