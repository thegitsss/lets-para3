# LPC release gates

A deployment candidate is releasable only when every required check below is green on the exact commit being deployed. A retry does not waive a failed check, and a manual deploy does not waive this policy.

The latest local evidence snapshot and current NO-GO decision are recorded in `docs/LAUNCH_CERTIFICATION_CURRENT.md`.

## Required branch protections

- Require pull requests for `main`; prohibit direct pushes and force pushes.
- Require one approval from a code owner who did not author the candidate; the repository owner cannot self-approve their own change.
- Dismiss stale approvals when the diff changes; require resolution of every review thread.
- Require `Deployment Blueprint`, `Runtime, dependency, and test gates`, `Browser contracts`, `Dependency review`, `CodeQL`, and `Secret scan`.
- Require the branch to be current before merge and require signed commits where the repository plan supports them.
- Restrict production deployment to the protected `production` environment with an explicit approver.

## Candidate evidence

- Exact Git commit and Node version from `.node-version`.
- A passing `npm run check:candidate` before dependency installation, with its retained owner-only manifest binding the clean checked-out commit, exact observed/pinned Node and npm runtimes, lockfile, legal documents, workflow, Blueprint, checklist, certification, and other critical release-file hashes. In GitHub Actions, `GITHUB_SHA` must equal checked-out `HEAD`.
- Reproducible `npm ci` from the committed lockfile.
- Passing CI-workflow and repository-policy contracts, including catch-all CODEOWNERS coverage and weekly npm/GitHub Actions dependency monitoring.
- A candidate secret scan over tracked and untracked nonignored files, plus a full-history secret scan in CI.
- A clean `npm ls --omit=dev --all` production tree with no missing, invalid, or extraneous packages; a CycloneDX production SBOM; a fail-closed production-license policy with source-backed evidence and explicit review for every new or unknown identifier; and retained Jest/browser JUnit artifacts for the exact CI run.
- Licensed, versioned, and byte-verified vendored browser assets with immutable upstream provenance; obsolete styles or duplicate integrations are stop-ship stale code.
- Zero high or critical production dependency vulnerabilities.
- Complete Jest pass with clean test output, focused payment and authentication passes, deterministic UI contracts (including semantic dialog safety, the real profile-photo crop interaction, and useful visual fixtures), frontend-to-backend API-literal contract validation, and critical role-based Playwright journeys across the lockfile-pinned Chromium, Firefox, and WebKit engines and the shared mobile/tablet/laptop/wide-desktop matrix in `docs/BROWSER_SUPPORT.md`.
- Production-surface hygiene evidence showing no native browser dialogs, placeholder `#` actions, query-enabled demo mode, fabricated demo/mock records, unfinished copy, or full-screen delayed loader remains; legitimate failure states must identify unavailable data instead of manufacturing values.
- Public indexing evidence showing unknown routes return an actual no-store/noindex 404, the sitemap exactly matches the approved indexable-document allowlist, all other HTML defaults to `noindex, nofollow`, and API representations are excluded from crawling.
- Render Blueprint schema validation and LPC's canonical-origin, runtime, health-check, graceful-shutdown, CI-gated deploy, secret-declaration, supervised incident-worker, automation-cron, and operations-monitor contract.
- Automation-containment evidence proving LPC maintenance mode prevents every scheduled mutation before any task starts, an unreadable control state fails closed, the operations monitor alerts on active/unreadable state, and one recovery transition follows authorized resumption.
- Explicit Attorney Assistant rollout configuration and retained Package 9 stage evidence for the deployed percentage. Missing or malformed rollout authority, an unrecorded stage advance, an enabled legacy model fallback, or dashboard-only enablement of the Paralegal upgraded manager is stop-ship.
- A retained passing `npm run verify:production` result produced from the clean candidate manifest after deployment. Every Render process must report that full commit; the canonical origin must return the same release header, exact candidate homepage/404/legal/discovery-file bytes, real 200/404 statuses, correct content types and cache policy, healthy database state, and the candidate security-header contract.
- Production configuration validation with live Stripe keys and the tested Stripe API version.
- AWS GuardDuty Malware Protection for S3 evidence for the exact production bucket: protected-resource status active, object tagging enabled, a canary upload receives `GuardDutyMalwareScanStatus=NO_THREATS_FOUND`, and tag-based access control denies reads for objects without that clean result.
- File-security evidence showing pending, threat, unsupported, access-denied, and failed scan results remain quarantined; admission/profile approval and Matter completion cannot advance through an unsafe file.
- Fresh MongoDB Atlas Cloud Backup evidence from the read-only monitor, an isolated restore drill, rollback owner, migration plan, and post-deploy health checks.
- The dry-run profile URL migration is reviewed, and the pre-deploy apply pass canonicalizes valid HTTP(S) URLs while clearing historical executable, credential-bearing, or non-LinkedIn profile links before the stricter model contract takes effect.
- Accessibility, performance, privacy, and security certification artifacts linked from the launch record.
- Named-counsel approval for the exact Terms and Privacy versions and SHA-256 digests, with a passing `npm run certify:legal`.
- Personal-storage deletion evidence for replacement, clearing, mutation rollback, stale-held reconciliation, post-claim bucket/owner/live-reference validation, blocked-record alerting, S3 retry/recovery, queue monitoring, and removal of the old object without deleting a live reference.
- Account-removal evidence proving unused accounts can be removed, accounts with durable history are minimized, operational accounts are excluded, and completed matters, messages, files, payouts, platform income, disputes, and audit records are not cascade-deleted.
- Communications index preparation includes `MatterFileNotification`, `MatterWorkNotification`, `MatterPaymentNotification` (funding-action and completed-Matter notices), `MatterWithdrawalNotification` (withdrawal requests, decisions, relisting and expiry), `MatterReviewNotification` (review opening, resolution and overdue reminders), `MatterApplicationNotification` (application submission and withdrawal), `MatterInvitationNotification` (invitation creation, acceptance, decline and revocation), `MatterPreEngagementNotification` (requirements, responses and requested changes), and `MatterPostingNotification` (publication, updates, removal and moderation requests). Verify the supervised worker, all nine Matter delivery queues, actual provider acceptance, and admin review/retry against the release candidate. An uncertain SMTP result requires provider-record review before an explicit retry; queued/accepted mail is not evidence of inbox arrival. Review historical gaps separately; deploying these queues does not backfill missed notices.
- The web-service build must generate current frontend artifacts with `npm run build:frontend`; production startup verifies their source, recipe, inventory and output hashes. The unchanged asset budgets apply to the generated files actually served. Verify compiled attorney/paralegal workflows and actual deployment alongside the public-page lab checks. See [frontend build instructions](FRONTEND_BUILD.md). Retained design previews are outside production assets and require an explicit local preview mode.
- Performance budget pass for the exact release commit and 28-day field Core Web Vitals at the 75th percentile, segmented by page and mobile/desktop. Until 28 days of representative production traffic exist, the field-vitals gate remains provisional and cannot be represented as measured production compliance.

## Stop-ship conditions

- Any unresolved money, authentication, authorization, data-loss, privacy, accessibility-blocking, or deployment rollback defect.
- Any failure on a supported browser/viewport critical journey, or any claim that Playwright WebKit/Chromium alone proves real Safari, Edge, iOS, or Android compatibility.
- Any skipped or focused test, flaky required test, unreviewed critical-file change, secret finding, unsupported runtime, missing dependency-license metadata, or unreviewed dependency license.
- Any unintentionally public source repository or unreviewed public disclosure of proprietary, personal, licensed, or security-sensitive material.
- Any unscanned or unowned legacy remote ref in a public repository, or bulk branch deletion without an exported inventory, incident/PR retention mapping, secret review, and explicit repository-owner approval.
- Any visible action that has no implemented backend operation, or any literal frontend `/api/` target that does not resolve to a mounted backend route.
- Any fake navigation target, native `alert`/`confirm`/`prompt` flow, fabricated operational fallback metric, query-enabled demo mode, unfinished user-facing copy, or deliberately delayed full-screen loading screen on a production surface.
- Any production setting that disables CSRF, uses Stripe test mode, lacks durable webhook signing, permits an unapproved origin, or lacks the data encryption key.
- Any user-upload prefix outside the malware-protection plan, any missing clean-tag read policy, any aged pending/error/blocked file without an operator disposition, or any claim that `S3_MALWARE_SCAN_REQUIRED=true` by itself proves the AWS protection plan is active.
- Any deployment that bypasses the protected `main` commit's required checks or uses an unreviewed Blueprint/schema change.
- Any missing, abbreviated, or mismatched Render release commit; public response body that differs from the approved candidate; live legal-document hash that differs from counsel approval; homepage soft-404; `robots.txt` or `sitemap.xml` homepage fallback/wrong content type; or production CSP that restores `script-src 'unsafe-inline'` or an unapproved script host.
- Any missing/stopped worker or cron, stale/missing Atlas snapshot, absent isolated restore drill, nonfunctional owner-alert path, or business scheduler still enabled inside the horizontally scalable web process.
- Any scheduled mutation that can run while LPC maintenance mode is active or its state is unreadable, any rollback instruction that treats Render web maintenance mode as a cron pause, or any resumption without due-work reconciliation and monitor recovery evidence.
- Any missing or mismatched counsel approval reference, version, or digest; any contractual provision left in the Privacy Policy; or any undisclosed AI support processor.
- Any stuck or repeatedly failing personal-storage deletion task, deletion of a currently referenced personal object, unowned-key deletion path, or missing deletion-queue alert/recovery evidence.
- Any account-removal path that deletes retained matter/financial/audit evidence, calls minimization “permanent deletion,” allows a minimized account to be re-enabled, or silently treats an HTTP failure as a successful batch operation.

The release owner records a go/no-go decision after reviewing the evidence. CI establishes the minimum bar; it is not a substitute for the final operational review.

## Production S3 malware-protection evidence

The application intentionally fails closed when `S3_MALWARE_SCAN_REQUIRED=true`. That setting is a software contract, not infrastructure attestation. Before launch, the release record must link screenshots or exported configuration proving all of the following for the bucket named by `S3_BUCKET`:

1. GuardDuty Malware Protection for S3 is enabled for the bucket and covers `cases/`, `profile-photos/`, `paralegal-resumes/`, `paralegal-certificates/`, and `paralegal-writing-samples/`.
2. GuardDuty object tagging is enabled and its service role can read, tag, and scan uploads without `ACCESS_DENIED` results.
3. The bucket/IAM tag-based access policy allows application reads only after the managed tag `GuardDutyMalwareScanStatus` equals `NO_THREATS_FOUND`; server-generated receipts and archives use a separate, narrowly scoped write/read path.
4. A harmless canary upload is initially denied, later tagged clean, and then readable. A quarantined test object or policy simulation demonstrates that missing, `THREATS_FOUND`, `UNSUPPORTED`, `ACCESS_DENIED`, and `FAILED` results cannot be read.
5. The LPC operations monitor is running and alerts on blocked/error/unprotected records, scans pending more than 15 minutes, and completed Matters missing an archive.
6. Legacy objects were re-scanned or explicitly disposed of. The production CaseFile migration marks legacy records pending; it does not manufacture clean evidence.

If any item is unproved, launch remains no-go even when application tests pass.

- Review-notice conversion must preserve delivery state while normalizing only missing `kind` to `opened`, creating the unique `(caseId, disputeId, userId, kind)` index, then dropping only the obsolete three-field unique key. Replace older communications workers before enabling new review-notice writers, including the recurring overdue job. Every active delivery worker must support opened, resolved and overdue kinds, including termination-context revalidation for opened notices. An older worker can incorrectly skip an unfamiliar kind or deliver a termination notice without its required current-context checks. Termination adds optional context fields without changing the existing four-field unique index; no historical context backfill is authorized by local acceptance. Verify target indexes and coordinated web/worker adoption explicitly; local tests do not establish target migration or mixed-version compatibility.

- Attorney inventory reads require the four nonunique indexes declared by the current Job and Application models: `inventory_job_identity_en` on Job `{ _id: 1, caseId: 1 }`, `inventory_case_reference_en` on Job `{ caseId: 1, _id: 1 }`, `inventory_application_job_en` on Application `{ jobId: 1, _id: 1 }`, and `inventory_application_identity_en` on Application `{ _id: 1, jobId: 1 }`. Each uses `{ locale: "en", strength: 3 }` collation. Prepare and verify these exact definitions against the authorized target before enabling the corrected inventory source; preserve existing unique and unrelated indexes. Production disables automatic index creation. Local disposable-database query plans do not establish target adoption. Retain target index metadata and the existing owner-scoped Matter/Home acceptance under E9.

- The same Job model also declares the nonunique `discovery_case_reference` index on `{ caseId: 1, status: 1, createdAt: -1, _id: -1 }` with `{ locale: "simple" }` collation for Browse/recommendation joins across BSON and retained string Case references. Prepare and verify that exact definition under the same E9 target-adoption check, preserving the existing ObjectId-only unique index and the four inventory indexes above. The local captured-data query-plan and byte-equivalence results do not establish production index adoption.

- Application-submission notices require the new unique `(applicationId, submissionKey, userId)` and delivery-scan indexes before enabling the new submission writer. Run the named communications index preparation and adopt the matching supervised worker and admin review controls. Email delivery revalidates the exact retained submission and current recipient/access after mirror reconciliation. The new queue does not backfill older applications or establish provider acceptance in the target environment.

- Application-withdrawal delivery uses the existing application queue and its unchanged unique/delivery-scan indexes. Adopt the worker that understands withdrawn canonical and earlier Matter-only events together with the writer and admin labels. Do not run an older submission-only worker against new withdrawal obligations. No historical applications are backfilled; the retained opaque submissionKey field also holds withdrawal hashes that include kind and source identity.

- Invitation creation and response delivery require the unique `(caseId, invitationKey, kind, userId)` and delivery `(status, nextAttemptAt, createdAt, _id)` indexes before the writer is enabled. Coordinate the web writer, supervised communications worker and admin recovery controls. Existing invitations are not backfilled. Local synthetic delivery and SMTP checks do not establish production provider acceptance or mixed-version compatibility.

- Pre-engagement notices require the unique `(caseId, revisionKey, kind, userId)` and delivery `(status, nextAttemptAt, createdAt, _id)` indexes before enabling the new request/response/review writers. Coordinate web and supervised communications worker adoption plus Admin recovery controls. Each original recipient obligation is retained in the same transaction as its pre-engagement revision and revalidated before sending. Approval creates no new notice; older requirements are not backfilled. Verify target indexes, provider acceptance and mixed-version adoption externally.

- Posting/moderation notices require the unique `(caseId, eventKey, kind, userId)` and delivery `(status, nextAttemptAt, createdAt, _id)` indexes before the new writers are enabled. Coordinate web, supervised communications worker and Admin recovery adoption. Publication retains the original administrator email audience; removal retains its original mandatory recipient policy and minimal historical explanation after deletion. Delayed notices check current ownership, access and relevant saved state. Verify actual target index preparation, current worker adoption, provider acceptance and removal-history presentation externally. No historical backfill or new recipient policy is authorized.
