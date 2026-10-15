# Establish the existing AWS session needed for approved staging verification

Owner approval recorded 2026-10-13: **one staging KMS key at $1/month and up to $1 total AWS usage for this verification run. No other paid services, subscriptions or charges.** Production migration/deployment remain unapproved. No Render redeploy, paid service change, billable app traffic or email check is authorized by these steps.

## What was checked

Current read-only STS identifies the configured runtime credential as `arn:aws:iam::096929701923:user/paraconnect-uploader`. IAM GetUser/ListAttachedUserPolicies/ListUserPolicies return 403. This does not prove every possible permission is denied; it does not establish an authorized provisioning role. That uploader is excluded from the provisioning helper, and its permissions must not be broadened.

No `aws` executable was available on PATH. No home/workspace `.aws/config` or `.aws/credentials`, home SSO/CLI caches, or AWS profile/credential/web-identity environment settings were present. No browser or app is available to automation through CUA. There is consequently no existing authorized provisioning session accessible to this agent. Discovery evidence: `outputs/document-security-20261013/aws-session-discovery.json` and `provisioning-access-readonly.json`.

## Exact provisioning grant

`outputs/document-security-20261013/provisioning-permissions.json` is the exact inline-policy action/resource/condition list for this **create-only** template, its read callbacks and ordinary rollback. Attach it only if needed to an existing trusted provisioning identity/session role, using your existing AWS administrator access. An existing authorized administrator role can be used without altering its policy. Do not attach this policy or login permissions to `paraconnect-uploader`. No new paid identity subscription, Identity Center instance or CloudFormation execution role is required.

The grant is limited to:

- CloudFormation stack `arn:aws:cloudformation:us-east-1:096929701923:stack/lpc-document-security-staging/*`; validation is a resource-independent read. Creation rejects a supplied CloudFormation service role, so a privileged role cannot be passed through this helper.
- IAM user `lpc-staging-document-app` and role `lpc-staging-document-scanner`: create/read/tag/inline-policy actions and rollback deletion; application access-key create/list/delete is scoped to that staging user only. The scanner role may be passed only to `malware-protection-plan.guardduty.amazonaws.com`.
- S3 configuration actions for `arn:aws:s3:::lpc-staging-documents-096929701923-us-east-1` only. This provisioning policy grants no document-body reads/writes; those use the separately scoped staging application identity and enforced bucket quarantine.
- KMS creation constrained to symmetric ENCRYPT_DECRYPT and request tags Environment=staging, Application=LPC, Data=synthetic-only; subsequent key reads/configuration/alias targeting require those same existing resource tags. Alias creation/deletion is restricted to `alias/lpc-staging-documents`. Resource-independent `kms:ListAliases` is required for CloudFormation’s read callback; it grants metadata listing only, no production-key modification or decryption. CreateKey necessarily uses Resource `*` because the new key ID does not exist yet; it is not permission to change a production key. Key deletion/disable and production migration permissions are not granted.
- GuardDuty plan creation requires the same staging request tags; plan read/retirement requires matching resource tags. CreateMalwareProtectionPlan necessarily uses Resource `*`; its passed scanner role has access only to the new staging bucket/key. The existing production plan is not granted by this policy. No detector creation or full GuardDuty enablement is granted.
- Every grant requires caller account 096929701923 and requested region us-east-1. Native IAM/CloudFormation resource creation adds no paid subscription; only the already approved bucket/key/scanning usage is proposed.

Every listed action was checked against the current official AWS service authorization catalogs. This is a narrowly scoped operational grant for a trusted operator, not a permission boundary or a live IAM simulation result. An already broader role retains its other existing grants; the reviewed helper/template and owner authorization govern use. Do not modify the existing uploader or production resources. If an organization policy or permission boundary blocks creation, report the exact denied action; do not compensate with AdministratorAccess on the uploader.

## What you must do

1. **Sign in to the existing AWS account** 096929701923 using the existing provisioning/admin identity you already use. If it lacks the needed creation permissions, your administrator must attach the provided inline policy to that trusted identity/session role. This is an AWS IAM authorization step; no credentials need to be sent to me.
2. **Install/update the free official AWS CLI v2 on this Mac**, minimum 2.32.0 for browser login. Use [AWS's macOS installer instructions](https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html). No system installation was performed by the agent. A temporary official package download failed local signature verification; it was not executed and was removed. Do not bypass macOS signature verification.
3. **Create a local authenticated profile**, choosing the existing provisioning identity rather than the uploader. In Terminal run:

   ```sh
   aws login --profile lpc-staging-provisioner --region us-east-1
   aws sts get-caller-identity --profile lpc-staging-provisioner --region us-east-1
   ```

   Complete the sign-in in your browser. The identity must be account 096929701923 and must not be `paraconnect-uploader`. Browser login uses locally cached temporary credentials; never paste login codes, tokens or keys into chat. If the existing IAM/federated identity needs browser-login permission, have your administrator grant only `outputs/document-security-20261013/browser-login-permissions.optional.json` (same-device OAuth client in this account/region) to that provisioning identity. This login grant is separate from creation permissions and does not authorize the uploader. [AWS browser-login documentation](https://docs.aws.amazon.com/cli/latest/userguide/cli-configure-sign-in.html).

   If you already use IAM Identity Center, use the existing SSO configuration instead: `aws configure sso --profile lpc-staging-provisioner`, then `aws sso login --profile lpc-staging-provisioner`. Select your existing account and authorized role; do not enable a new Identity Center service or subscription. No new configuration is needed if an existing named profile already grants the required access; tell me its profile name only.
4. **Tell me “AWS provisioning login complete”** (or the existing profile name). I can then use that local session, validate the reviewed template, create only the approved resources and run real AWS canaries. You do not need to run the provisioning command or supply nonexistent staging resource identifiers. If login fails, give the error/action name, not a token or credential.

## Prepared execution, not yet performed

`backend/scripts/provision-staging-document-storage.sh` defaults to read-only preflight, verifies the approved template SHA-256 and account, and refuses the production uploader. `--create-approved` creates the exact nine-resource reviewed stack with direct `--template-body`; it does not upload the template to a new helper bucket, create a CloudFormation execution role, deploy Render or create/print access keys. CloudFormation outputs are nonsecret bucket/key/role/plan identifiers. Existing-stack creation fails rather than silently updating it.

After successful creation, stage-only application credentials must be created privately and stored in Render **LPC staging secrets** without linking/redeploying a service or making billable Render app requests for this AWS-only verification run. Verification can run locally against AWS. Raw credential-producing CLI output must never be printed. Provisioning/SSO admin credentials must not be mounted in the application secrets group. The existing application database, Stripe test settings and prior email receipts remain unchanged.

The bounded canary tests encryption and versioning, clean/infected managed scan tags, pending/unsafe denial, forged tag attempts, wrong encryption/key and anonymous/signed read restrictions. Provider failure/recovery and unavailable scan handling require isolated tests after resources exist. Do not certify provider acceptance from local tests. No additional monitoring services, queues, log subscriptions, new workers or paid services will be created.

## Usage and cleanup at this blocked point

Created staging resources: **none**. Live uploads/scans: **none**. Estimated new staging AWS charges incurred: **$0**; $1/month key billing has not started. Only identity/policy read calls were made. No cloud cleanup is necessary because nothing was created. The unused installer download was removed. The policy, template, test scripts and evidence files are deliberately retained for review and execution. No production mutation, Render deployment or email sending occurred.

Approval cap remains $1/month for the single staging CMK plus **$1 total**, not $1 recurring usage. After access exists, record object versions, evaluated scans, requests and transferred bytes; delete synthetic test versions using the staging identity after evidence capture. Keep or retire only the approved staging resources under the reviewed cleanup procedure; never disable/delete a key while retained test objects require it. Report any unsupported/failing scan without granting access. A budget alert is not a hard spending cap.
