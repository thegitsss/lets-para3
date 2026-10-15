# LPC isolated document-security staging proposal

Prepared 2026-10-13. **Owner now approves one staging KMS key at $1/month and up to $1 total AWS usage for this verification run. No additional charges/services or production changes are authorized.** The approved isolated stack is now created. Real AWS encryption, clean/infected/pending reads, principal restrictions, scan-failure/tagging-unavailable quarantine and recovery checks passed. All synthetic document versions were removed; the scanner policy was restored. See `outputs/document-security-20261013/status.json` for current evidence. Completed email receipt checks remain closed. See [current access setup](staging-aws-access-setup-20261013.md).

## Confirmed facts and limits

A fresh `GetBucketEncryption` read using the deployed backend's privately held AWS credentials confirms account `096929701923`, region `us-east-1`, production bucket `paraconnect-uploads` defaults to **SSE-S3 / AES256**. No customer-managed KMS key is configured in that returned default. This establishes the default, not the encryption or scan state of every historical object/version. The returned BucketKeyEnabled flag is not evidence of customer-managed KMS use with AES256. See `outputs/document-security-20261013/production-encryption-readonly.json`.

Owner screenshots identify production GuardDuty plan `12d0866a656f5bf59eb2` as Active and show no customer-managed KMS keys in this region. They do not establish scan enforcement, plan prefix coverage, key policy, historical inventory or successful application access. There is no identified staging storage resource; this proposal creates one after approval rather than searching for nonexistent IDs.

The existing isolated Render application is `https://lets-paraconnect-backend.onrender.com`, service `srv-d10gdh24d50c73ap2p60`. Its staging database and Stripe test sandbox are retained. The document-storage changes described here have **not** been deployed there. Do not attach staging secrets to production service `srv-d3o54nc9c44c73cm5kn0`.

## Minimum deployment

The generated CloudFormation template is `outputs/document-security-20261013/staging-storage.cloudformation.json`; source is `backend/infra/stagingDocumentStorage.js`.

| Resource | Proposed configuration |
| --- | --- |
| S3 bucket | `lpc-staging-documents-096929701923-us-east-1`; synthetic records only; versioning; all public access blocked; bucket-owner enforced; incomplete multipart uploads aborted after one day |
| Customer-managed KMS key | One symmetric regional key, alias `alias/lpc-staging-documents`; exact key ARN required on application uploads; S3 Bucket Keys enabled; key retained on stack removal |
| GuardDuty | Separate Malware Protection for S3 plan protecting the entire staging bucket; result tagging enabled; independent protection, no new general GuardDuty detector |
| Application identity | One IAM user without console login or provisioned access keys; scoped data permissions, no production bucket access |
| Scanner identity | One service-trusted IAM role with the documented managed EventBridge-rule, S3 scan/tag/validation and staging KMS permissions |
| Hosting/worker | Existing isolated Render service; no additional paid Render service, database or email worker |

CloudFormation creates no access keys and outputs no secrets. Credentials, if approved and created later, go directly into Render **LPC staging secrets**, linked only to the isolated service. Keep short-lived credentials if a supported refresh mechanism is available; otherwise use one dedicated staging access key pair with explicit rotation/revocation. Do not reuse production keys or paste values into chat, evidence or source control. Remove any inherited legacy-upload manifest settings. The nonsecret mapping is `outputs/document-security-20261013/render-staging-storage.nonsecret.json`.

Application S3 rights cover only Matter files and existing resume/certificate/writing-sample/photo prefixes: upload, authorized reads, tag reads, deletion, version reads/deletion and required multipart operations. List rights are prefix restricted. KMS GenerateDataKey/Decrypt require S3 in us-east-1, this account, this bucket's encryption context and this exact key. Both bucket ARN and object ARN contexts are permitted because S3 Bucket Keys use bucket context. No application tag mutation, IAM administration, key administration or production storage permissions are granted.

GuardDuty may read objects/versions, read/write result tags, validate the bucket with its designated validation object, enable the bucket's EventBridge notification, inspect ownership and manage only the service-managed EventBridge rule names. KMS grants allow only the new staging key through S3. The trust principal follows AWS's documented Malware Protection service principal; unsupported SourceArn assumptions are not added.

## Scan enforcement and failure behavior

The bucket denies current and version reads unless `GuardDutyMalwareScanStatus=NO_THREATS_FOUND`, except for the scanner role. HEAD requires the same underlying read authorization. Application code checks scans before HEAD and retains version/ETag validation around content reads. A previously minted signed URL also encounters bucket enforcement. Role/Matter membership and account status remain application authorization checks; the backend IAM identity is not a replacement for those checks.

Only the scanner may mutate result tags. The application cannot upload a forged scan tag or copy an object's inherited clean tags. New uploads require `aws:kms` and the exact staging key ARN. All data operations require TLS; anonymous and other application identities are denied. Staging has no legacy-unverified compatibility exemption.

| Scan/provider state | Application result | Read/download behavior |
| --- | --- | --- |
| Missing, pending or unknown tag | 423 `FILE_SCAN_PENDING` | No download link or content; bounded wait, then remain unavailable |
| `NO_THREATS_FOUND` | Available subject to role/Matter checks | Current/explicit version still checked against storage identity |
| `THREATS_FOUND` | 422 `FILE_SECURITY_BLOCKED` | Quarantined; no automatic clean override or tag deletion |
| `UNSUPPORTED`, `ACCESS_DENIED`, `FAILED` | 503 `FILE_SCAN_ERROR` | Quarantined; operator investigates and requests a bounded rescan |
| Tag lookup timeout, unavailable service or denied verification | 503 `FILE_SCAN_ERROR` | Fail closed; cancellation remains cancellation; missing object remains 404 |
| Scan result exists but tagging failed | Tag remains absent | Read remains denied; post-scan-action failure must be investigated |

A failed/unavailable scan never ages into an allowed read. Retry only after correcting the cause, with a limited backoff and an operator-triggered rescan where necessary. Repeated browser polling checks tags; it must not launch repeated billable scans. State-change events can update display state but are never trusted in place of checking the exact S3 version's managed tag.

For the bounded supervised staging run, poll tags and inspect GuardDuty metrics/plan state directly; retain pending/error evidence. No new queue/Lambda/worker is needed. Production adoption requires durable operational alerting for failed/skipped/infected scans, protection-plan errors and post-scan tagging failures; that is costed separately below.

## Deployment prerequisites and sequence — after approval only

1. Obtain owner approval for new AWS charges. Verify the deployment session's account with `aws sts get-caller-identity` and explicitly select us-east-1. Stop unless the account is exactly `096929701923`. No controllable AWS browser session is available. A read-only STS check identifies the configured credential as `arn:aws:iam::096929701923:user/paraconnect-uploader`; IAM GetUser, ListAttachedUserPolicies and ListUserPolicies each returned 403. This does not establish creation permissions; an authorized provisioning session/role has not been verified. No write-permission probes were attempted. Evidence: `outputs/document-security-20261013/provisioning-access-readonly.json`.
2. A deployment identity needs CloudFormation stack validation/create/describe for the isolated stack, named IAM user/role/policy creation and tightly scoped PassRole for the scanner service, S3 bucket/policy/encryption/versioning/public-block/ownership/notification setup, KMS key/alias/policy creation and GuardDuty Malware Protection plan creation. These are provisioning privileges, not privileges to grant to the runtime user. Review the change set: exactly these staging resources, zero existing production changes. Explicit account/region preflight is mandatory; template names alone are not a deployment-account guard.
3. Create the isolated stack with `CAPABILITY_NAMED_IAM`; require the protection plan to report Active. Record nonsecret bucket/key/plan outputs. Validate scanner permissions, result-tag writing and KMS decryption using synthetic files, not production copies.
4. Create the approved staging-only application credential and write it privately to **LPC staging secrets** along with reviewed outputs and fingerprints. Link that group only to the staging service. Remove obsolete direct duplicate S3 env values so precedence cannot mask the group. Preserve the working isolated database/test payments/session keys. No secret appears in this proposal.
5. Deploy the reviewed application candidate to staging only. Keep the password gate and synthetic accounts. Run `backend/scripts/staging-document-canary.cjs` in plan mode first. Execution requires explicit `--execute-approved` and exact staging env validation; it is bounded to five upload attempts, 64 KiB uploaded data and 120 tag polls. It leaves synthetic versions for diagnosis and reports version IDs, never signed URLs/credentials. No execution was performed during preparation.
6. Observe clean PDF and harmless EICAR test-pattern scan results; test pending reads, anonymous access, encrypted HEAD metadata, forged tags and wrong encryption. If the scanner completes before a pending read can be observed, mark that canary partial and obtain separate provider evidence; do not declare it passed.
7. Through the hosted application, test attorney and paralegal upload/attachment/preview/download/delete, confidentiality files, resume/photo controls and archive/export behavior. Check unauthorized/nonparticipant/revoked-account access, exact-version races and signed-URL expiry. Review both roles' actual rendered scan states. Local mocked-provider tests do not replace these checks.
8. In staging only, perform controlled scanner permission/unavailability and failed-tag recovery drills with the approved deployment identity. Capture denied reads and eventual recovery; restore reviewed policy immediately. Unsupported inputs must remain unavailable. Do not manipulate production scanner permissions.
9. Keep the hosted workload bounded to at most 100 synthetic objects, 1 GB scanned, 1 GB retained, 1 GB outward transfer, 1,000 Tier-1 requests, 5,000 Tier-2 requests and 1,000 KMS operations. Track retained versions and scan attempts. Stop if approaching the approved usage allowance. An AWS Budget alert is not a hard spending cap.
10. Remove all synthetic object versions/delete markers using the staging identity before retiring it. Remove the staging protection plan, revoke its access keys, then review deletion of the retained empty bucket and staging key separately. Stack deletion alone deliberately retains bucket/key and can leave charges running. Never disable or delete a key while retained documents still need it. Production resources are excluded from every cleanup operation.

## Itemized costs — USD, us-east-1

Public regional AWS price catalogs were read 2026-10-13; evidence is `outputs/document-security-20261013/aws-public-price-rates.json`. Prices exclude tax/support, account-wide existing commitments and provider changes. Shared free tiers/credits are **not assumed available**, because production can already consume them. Re-check before a later purchase.

| Item | Fixed charge | Usage rate |
| --- | --- | --- |
| Customer-managed symmetric KMS key | $1/key/month initially, prorated hourly | $0.03/10,000 symmetric requests |
| KMS rotation | First and second retained rotated key versions each add $1/month; further rotation charges capped | Stage rotation disabled for its temporary life; eventual production annual rotation proposed separately |
| S3 Standard storage, including retained versions | $0 bucket-creation charge | $0.023/GB-month, first 50 TB tier |
| S3 PUT/COPY/POST/LIST and tag-write class | $0 | $0.005/1,000 requests |
| S3 GET/HEAD/tag-read class | $0 | $0.0004/1,000 requests |
| S3 result-tag storage | $0 | $0.0065/10,000 tag-months |
| GuardDuty Malware Protection for S3 | No fixed per-plan charge; no duplicate general detector proposed | $0.09/GB scanned + $0.215/1,000 evaluated objects; rescans add usage |
| S3 internet outward transfer, including to Render | $0 | $0.09/GB first paid tier beyond shared allowances |
| IAM identities/policies, native CloudFormation stack, service state-change EventBridge events | No new fixed charge | No paid custom-event stream proposed |
| Existing Render/isolated DB/test Stripe configuration | $0 additional fixed service purchase in this proposal | Existing hosting/provider usage still applies; prior Render bandwidth approval is separate |
| Optional production operational alarms | $0.10/standard alarm metric/month; proposed three = $0.30/month | Uses GuardDuty FailedScanCount, SkippedScanCount and InfectedScanCount |
| Optional production SNS operational alerts | $0 fixed | $0.50/million publishes + $2/100,000 email deliveries, excluding shared free allowances |
| Optional CloudWatch log retention, if adopted later | $0 fixed | $0.50/GB standard ingestion + $0.03/GB-month retention; not provisioned in minimum staging |

GuardDuty metrics are `AWS/GuardDuty/MalwareProtection`, with exact dimensions `Malware Protection Plan Id` and `Resource Name`; use SUM for scan counts. EventBridge rules for scan failures, plan errors/warnings and post-scan action failures must filter the correct bucket/plan and send operational alerts without document bodies or bearer URLs. No new operational emails were sent; recipient remains admin@lets-paraconnect.com.

**Conservative staging monthly example**, not a flat quote: one key ($1), 1 GB retained ($0.023), 1 GB scanned ($0.09), 100 evaluated objects ($0.0215), 1,000 writes ($0.005), 5,000 reads ($0.002), 1,000 KMS operations ($0.003), 1 GB outward transfer ($0.09), 100 result tags ($0.000065) = **$1.234565, approximately $1.24**. The tiny automated canary is much smaller. Key billing continues until reviewed retirement; version retention increases storage. Proposed authorization: **$1/month for the staging key plus up to $1 of staging AWS usage for this verification run**, with no additional paid Render service. This is a bounded work allowance, not an AWS-enforced hard cap.

**Eventual production example**, separately unapproved: one new production key ($1), 100 GB retained ($2.30), 100 GB newly scanned ($9), 10,000 evaluated objects ($2.15), 20,000 writes ($0.10), 100,000 reads ($0.04), 30,000 KMS operations ($0.09), 100 GB outward transfer ($9), 10,000 tags ($0.0065) = **$23.6865/month** total modeled storage/security/transfer usage. Three alarms add $0.30; 100 SNS publish/email alerts add about $0.00205. Logs are optional and not included. These are workload examples, **not measurements of LPC production**. Existing bucket storage, transfer and the existing GuardDuty plan are reused, not purchased twice. The principal incremental fixed production charge is the separate KMS key ($1 initially, up to $3 after the first two rotations), plus adopted monitoring. Existing S3/GuardDuty baseline charges should not be labeled new costs.

**One-time production re-encryption**, separately unapproved: for N rewritten versions totaling B GB, model COPY/PUT requests `0.005*N/1000`, up to roughly two symmetric KMS operations per object `0.03*2*N/10000` (actual Bucket Key caching can reduce this), rescanning `0.09*B + 0.215*N/1000`, plus HEAD/tag polling and retained-version storage `0.023*extraGB*retentionMonths`. Each automatic or on-demand scan is counted once; repeated scans add charges. Server-side in-region copies avoid downloading real data through Render. Current SSE-S3 originals do not require a KMS decrypt, so the two-operation estimate is conservative. No S3 Batch Operations job or paid inventory/export job is included. Actual N/B/versions must be inventoried before approving a migration total.

## Verification status and blockers

CloudFormation lint passed with cfn-lint 1.46.0. **99 focused local security/canary tests and 74 Mongo-backed access/dispute/export tests passed (173 total across eight suites).** The cloud-canary test uses substituted S3/HTTP providers; none is live AWS acceptance. Full results are recorded in `outputs/document-security-20261013`. Local policy modeling is not AWS IAM simulation or evidence that the provisioned scanner works. The canary's plan-only output is not a live upload test.

Remaining prerequisites: an accessible authorized AWS provisioning session/role (cost approval is now recorded); approved isolated resources and securely mounted credentials; actual cloud upload/KMS/scanning/failure-recovery evidence and hosted role/interface acceptance. Production deployment and existing-file migration require separate approval after isolated verification. Completed email receipts are not a blocker and will not be reopened. Whole-LPC user readiness/full financial lifecycle remains a separate incomplete release gate.

## Primary references

- [S3 pricing](https://aws.amazon.com/s3/pricing/), [KMS pricing](https://aws.amazon.com/kms/pricing/), [GuardDuty pricing](https://aws.amazon.com/guardduty/pricing/), [CloudWatch pricing](https://aws.amazon.com/cloudwatch/pricing/), [SNS rates](https://aws.amazon.com/sns/faqs/).
- [GuardDuty role permissions](https://docs.aws.amazon.com/guardduty/latest/ug/malware-protection-s3-iam-policy-prerequisite.html), [tag-based access enforcement](https://docs.aws.amazon.com/guardduty/latest/ug/tag-based-access-s3-malware-protection.html), [supported encryption](https://docs.aws.amazon.com/guardduty/latest/ug/supported-s3-features-malware-protection-s3.html).
- [CloudFormation protection-plan resource](https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-resource-guardduty-malwareprotectionplan.html), [GuardDuty metrics](https://docs.aws.amazon.com/guardduty/latest/ug/monitor-cloudwatch-metrics-s3-malware-protection.html), [scan events](https://docs.aws.amazon.com/guardduty/latest/ug/monitor-with-eventbridge-s3-malware-protection.html), [KMS/Bucket Key contexts](https://docs.aws.amazon.com/AmazonS3/latest/userguide/UsingKMSEncryption.html).

## Verified AWS run — 2026-10-13

Stack `lpc-document-security-staging` is CREATE_COMPLETE. Bucket `lpc-staging-documents-096929701923-us-east-1`, customer-managed KMS key `arn:aws:kms:us-east-1:096929701923:key/13243f5b-28b5-4794-a4de-fa9480ead99b`, and separate GuardDuty plan `d0d09aefa38185a4bd5b` (ACTIVE) were verified against real AWS. Application user and scanner role are staging-only. Credentials are stored privately in the existing unlinked Render group `LPC staging secrets`; no deployment or service purchase occurred.

Real AWS checks passed: exact encryption key and versioned uploads; forged scan tags rejected; AES256 rejected; pending/infected reads and infected signed URLs denied; clean reads allowed after actual GuardDuty results; other authenticated principals denied; application prefixes restricted; actual scanner ACCESS_DENIED quarantine; unavailable tagging quarantine; recovery to new clean versions with older failed versions still denied. AWS normalizes an alias of the same authorized KMS key to its exact key ARN; the alias is allowed and does not change the encryption key. A nonexistent other key returned KMS.NotFoundException (400), which is provider validation rather than proof of an IAM 403.

Cleanup removed 13 synthetic document versions across initial attempts and final checks; final staging inventory retains only the GuardDuty validation object. Scanner policy restored; approved staging stack/key retained for reuse, so the key continues at $1/month (prorated). Estimated variable usage under $0.05, conservatively excluding free allowances; this is not a settled AWS invoice. No new subscriptions, production changes, Render deployments, or emails.

Hosted application and Attorney/Paralegal interface acceptance remain separate unverified gates: the new storage configuration has not been linked/deployed to the staging application. Production adoption remains unapproved. This AWS result does not certify whole-LPC user readiness.
