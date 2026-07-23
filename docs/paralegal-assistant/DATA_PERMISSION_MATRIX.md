# Paralegal Assistant Data and Permission Matrix

Audit date: July 23, 2026

## Evidence states

| State | Meaning | Required response |
| --- | --- | --- |
| `verified` | Authorized source returned an unambiguous fact | Answer directly and concisely |
| `absent` | Lookup succeeded and confirmed no record/value | State that it is not present |
| `unknown` | Records exist but do not safely prove the conclusion | Name the missing evidence; clarify only if useful |
| `temporarily_unavailable` | Authoritative lookup failed or is not configured | Say it cannot be checked now; do not call it absent |
| `unauthorized` | Role, relationship, or record access failed | Decline record-specific disclosure without confirming sensitive details |
| `not_applicable` | The question does not apply in the current state | Explain the current state and next applicable step |
| `blocked_policy` | Code sources or product rules conflict | Use the approved limitation; never improvise |

## Record relationships

| Relationship | Allowed evidence | Forbidden inference |
| --- | --- | --- |
| Assigned paralegal | Safe matter/workspace fields needed for current work | Attorney billing credentials, other applicants, internal notes |
| Pending invitee | Invitation and approved preview fields for that invite | Full workspace, files, messages, or unrelated applicant data |
| Applicant | Own application plus approved posting fields | Other applicants, attorney private information, hidden shortlist notes |
| Requested pre-engagement paralegal | Own requested requirements and response state | Other candidates’ documents or disclosures |
| Withdrawn paralegal | Own withdrawal, dispute window, finalized payout, and approved receipt state | Replacement paralegal/workspace activity after access revocation |
| Completed paralegal | Own completed matter and payout history | Attorney financial methods or unrelated matter records |
| Unrelated paralegal | Public browse data only where product permits | Existence or details of private/assigned matters |

## Account and profile data

Allowed for the signed-in paralegal:

- identity, role, approval, safe profile completeness inputs;
- availability and profile visibility markers;
- resume/certificate/writing-sample metadata only when readiness is verified;
- own preferences, notifications, and safe 2FA markers;
- Stripe Connect readiness and safe bank display fields such as bank name/last four only when explicitly requested and authorized.

Never expose:

- password/hash, sessions, OTP seeds, backup codes, temporary codes;
- raw Stripe account objects, account IDs, transfer IDs, tokens, bank routing/account numbers;
- admin audit notes, moderation deliberations, fraud/risk signals;
- another user’s contact, profile, payout, or security data beyond approved workflow display fields.

## Matter and work data

Allowed only after a database query enforces the signed-in paralegal’s relationship:

- matter title, status, deadline, safe attorney display name;
- assigned scope tasks and completion state;
- paralegal-visible file metadata, review/revision state, and approved availability;
- own messages and canonical response state;
- own invitation, application, and pre-engagement state;
- own withdrawal, dispute, completion, release, and payout state.

Never expose:

- other applicants or invitees;
- attorney internal notes or admin-only dispute/moderation fields;
- raw storage keys, unrestricted signed URLs, hidden document contents;
- messages from unrelated/nonparticipant conversations;
- work added after paralegal access was revoked unless an explicit retained-access policy authorizes it.

## Financial data

Allowed:

- locked matter gross amount where the paralegal is authorized;
- historical paralegal fee snapshot and finalized net payout for that paralegal;
- own payout history, safe status, and dates;
- prospective platform-fee policy clearly labeled as current policy;
- own Stripe Connect readiness and safe next steps.

Never expose:

- attorney charge, payment method, customer ID, card details, receipts, refunds, or processor secrets unless a distinct product contract explicitly permits a safe shared amount;
- another paralegal’s fee, payout, bank, or Connect state;
- unfinalized partial payout as final;
- bank arrival as confirmed from LPC release or transfer creation alone;
- current fee policy as proof of a historical fee snapshot.

## Tool enforcement requirements

Every future paralegal tool must:

1. derive identity and role from authenticated server context;
2. reject non-paralegal sessions before querying paralegal records;
3. enforce relationship/ownership in the database query;
4. request only fields required by its response contract;
5. return explicit evidence states for each conclusion;
6. distinguish absent, unavailable, unauthorized, and unknown;
7. include safe freshness/source metadata where timing matters;
8. ignore model-supplied user IDs as authority;
9. redact internal IDs, secrets, raw processor/storage objects, and forbidden fields;
10. keep application/invitation/assignment and completion/release/deposit states distinct;
11. never infer an attorney’s intent, obligation, review, or response without explicit evidence;
12. remain read-only.
