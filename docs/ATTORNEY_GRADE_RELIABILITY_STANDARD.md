# Attorney-Grade Reliability Standard

This is the operating standard for Let’s-ParaConnect.

It is not "Facebook-grade."
It is:

- secure enough for attorney use at LPC's actual scale
- stable enough that attorneys can trust the workflow
- reliable enough that one bad deploy or infra issue does not destroy trust

If this standard is not met, the platform should be treated as pilot-only, not mature.

## 1. Security Baseline

The platform passes this section only if all of the following are true:

- Authentication is required for all non-public attorney/paralegal surfaces.
- Role separation is enforced server-side, not just in the UI.
- CSRF protection is enabled where needed.
- Rate limits exist on auth and high-risk write paths.
- Security headers are enabled in production.
- Payment credentials, JWT secrets, S3 secrets, and email credentials are stored in environment variables only.
- Admin routes are protected and not reachable by normal users.
- Attorney signup disclosures that materially affect fees or legal boundaries are enforced, not just displayed.

Repo evidence:

- [backend/index.js](/Users/samanthasider/Desktop/lets-para3/backend/index.js)
- [frontend/signup.html](/Users/samanthasider/Desktop/lets-para3/frontend/signup.html)

Current status:

- Mostly met.
- The attorney `$400 minimum` acknowledgement is now enforced in signup.

## 2. Workflow Reliability

The platform passes this section only if all of the following are true:

- Attorney signup, login, onboarding, case posting, hiring, messaging, documents, and completion flows work repeatedly.
- Payment failure states fail safely and clearly.
- Realtime case activity has a fallback when live updates fail.
- Case state is preserved on refresh.
- Duplicate actions do not create double-hire, double-fund, or double-release outcomes.
- Draft save/load works for case creation.

Minimum release evidence:

- `npm run test:e2e:auth`
- `npm run test:e2e:profile`
- `npm run test:e2e:validation`
- `npm run test:e2e:matching`
- `npm run test:e2e:messaging`
- `npm run test:e2e:onboarding`
- `npm run test:e2e:realtime`
- `npm run test:e2e:payouts`
- `npm run test:e2e:job-escrow`

Repo evidence:

- [backend/package.json](/Users/samanthasider/Desktop/lets-para3/backend/package.json)
- [LAUNCH_CHECKLIST.md](/Users/samanthasider/Desktop/lets-para3/LAUNCH_CHECKLIST.md)

Current status:

- Strong.
- This is one of the healthier parts of the platform.

## 3. Data Durability

This is the most important non-UX section.

The platform passes this section only if all of the following are true:

- Database backups are automatic, scheduled, and recent.
- Backups are stored outside the primary runtime host.
- Restore is documented and has been tested against a fresh target database.
- Backup failure generates an alert.
- Files and receipts are stored in durable object storage, not local ephemeral disk.
- Recovery point objective is defined.
  Current target: no more than 24 hours of data loss.
- Recovery time objective is defined.
  Current target: service restored within 4 hours.

Repo evidence:

- [backend/scripts/backup-db.js](/Users/samanthasider/Desktop/lets-para3/backend/scripts/backup-db.js)
- [backend/scripts/restore-db.js](/Users/samanthasider/Desktop/lets-para3/backend/scripts/restore-db.js)
- [backend/backup-recovery.md](/Users/samanthasider/Desktop/lets-para3/backend/backup-recovery.md)
- [backend/routes/uploads.js](/Users/samanthasider/Desktop/lets-para3/backend/routes/uploads.js)

Current status:

- Not met.
- The repo has backup and restore tooling.
- The launch checklist still says backups are not confirmed and Atlas backups are manual only.

Required before calling the platform attorney-grade:

1. Enable scheduled or continuous Mongo backups.
2. Verify at least one successful restore into a separate database.
3. Record backup timestamp, restore timestamp, and operator.
4. Alert on backup failure.

## 4. Monitoring and Alerting

The platform passes this section only if all of the following are true:

- `/api/health` is monitored externally.
- Owner receives alerts for downtime, repeated 5xx responses, and failed deploys.
- Owner receives alerts for backup failures.
- Stripe webhook failures and payout failures are visible quickly.
- There is one place to check current platform health.

Repo evidence:

- [backend/index.js](/Users/samanthasider/Desktop/lets-para3/backend/index.js)
- [LAUNCH_CHECKLIST.md](/Users/samanthasider/Desktop/lets-para3/LAUNCH_CHECKLIST.md)

Current status:

- Partially met.
- Health endpoint exists.
- Owner alerting is still explicitly unchecked in launch notes.

## 5. Deploy Safety

The platform passes this section only if all of the following are true:

- There is a documented rollback path.
- The previous known-good deploy can be restored quickly.
- High-risk changes are validated before production use.
- Production environment values are verified before payment-related releases.
- Background jobs that mutate production data can be paused during incidents.

Repo evidence:

- [ROLLBACK_PLAN.md](/Users/samanthasider/Desktop/lets-para3/ROLLBACK_PLAN.md)
- [LAUNCH_CHECKLIST.md](/Users/samanthasider/Desktop/lets-para3/LAUNCH_CHECKLIST.md)

Current status:

- Partially met.
- Rollback path is documented.
- Production Stripe confirmation is still explicitly unchecked in launch notes.

## 6. Legal and Trust Clarity

The platform passes this section only if all of the following are true:

- The product clearly states it is not a law firm, not legal advice, and not an escrow service.
- Attorney supervision requirements are visible in the workflow and terms.
- No-client-on-platform boundary is explicit.
- Fee disclosures are shown before commitment points.
- Auditability exists for disputes, documents, messages, and financial decisions.

Repo evidence:

- [frontend/terms.html](/Users/samanthasider/Desktop/lets-para3/frontend/terms.html)
- [frontend/attorney-faq.html](/Users/samanthasider/Desktop/lets-para3/frontend/attorney-faq.html)
- [frontend/create-case.html](/Users/samanthasider/Desktop/lets-para3/frontend/create-case.html)

Current status:

- Strong.

## 7. Release Gate

Do not describe the platform as attorney-grade unless all of these are true:

- All core E2E flows pass.
- Live attorney and paralegal payment flow has been verified recently.
- Automatic backups are enabled and recent.
- Restore drill has been completed successfully.
- Uptime and error alerting are live.
- Production Stripe configuration is confirmed.
- No open severity-1 issue exists in auth, payments, case access, or data loss risk.

## 8. Current Read

As of April 1, 2026:

- Workflow quality: strong
- Legal/disclosure posture: strong
- Security baseline: decent to strong
- Monitoring: incomplete
- Data durability: incomplete
- Production reliability proof: incomplete

Bottom line:

- The platform can be good enough for a focused attorney product.
- It is not yet justified to claim top-tier reliability until backups, restore verification, and alerting are actually live and proven.

## 9. This Week Priorities

1. Turn on automatic Mongo backups.
2. Run a real restore test into a separate database and document the result.
3. Turn on owner alerts for uptime, 5xx spikes, deploy failure, backup failure, and Stripe webhook failure.
4. Confirm production Stripe live configuration.
5. Re-run payment and case-flow smoke tests after the above changes.
