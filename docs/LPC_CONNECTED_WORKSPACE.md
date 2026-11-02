# Connected work in LPC

This branch completes four connected features inside the existing attorney and paralegal portals. The existing matter, file, posting, account and payment systems remain the authority.

| Feature | Native location | Experience |
| --- | --- | --- |
| Document preparation | Matter → Work; submission review in Files | Choose source documents, follow recoverable background progress, review exact quotations and reading coverage, edit/add/remove working items, and accept an attorney-reviewed checklist. |
| Document collaboration | Files → select a clean DOCX → Edit in LPC | A full-size document dialog with co-editing, comments and tracked changes. Save to LPC follows a correlated callback receipt; closing returns to the same Files view and current version. |
| Clio | Settings → Connections; Matter → Files | Connect the US Clio account, review selected private source documents, author a public work brief for an LPC posting, import into an existing funded matter, and return an explicitly approved document to a selected Clio matter. Transfer history provides exact-operation recovery. |
| Matching by work | Find a Paralegal → Find by work | Describe the work, add explicit skill/experience/availability filters, review profile evidence, and open the existing candidate profile. Returning to results preserves the search in page memory. |

The interfaces use LPC's portal shell, typography, responsive layout and existing account lifecycle. Former tool-page URLs are compatibility redirects into the native portal. They retain valid matter/file identifiers and safe provider callback context. Sign-in returns preserve those entry points. Confidential search text and checklist edits never enter URLs or browser storage.

## Preparation and scanned documents

Preparation reads the agreed instructions and up to eight selected PDF, DOC, DOCX or TXT files. Each file is limited to 10 MB; PDFs to 80 pages; each request to 180,000 text characters. PDF text is read locally in a bounded worker. A PDF containing pages without readable text can use Amazon Textract in the existing US S3 region. OCR receives the exact security-checked, immutable S3 object version. No external results bucket is created.

Background requests persist encrypted actor/input/source context and OCR job checkpoints in MongoDB. The existing server starts the small queue worker after its database connection; no separate service is required. Leases allow an interrupted worker to resume. One active request per participant/matter prevents duplicate presses from opening parallel jobs. An uncertain request is checked with the same request ID. OCR polling and every processing boundary recheck the initiating actor, session, assignment, agreed instructions, file revision and security status. Revoked access stops processing. A changed source requires fresh preparation.

Progress reports actual stages and document counts, without estimated percentages. Provider failures retain a recoverable request when retry is safe. Exact source quotes are validated before saving suggestions. PDF citations identify a page; Word/text citations identify an extracted section. OCR, partial scan results and unreadable pages are visible in reading coverage. Handwriting, diagrams and images may contain information that text extraction cannot represent.

Only the attorney accepts a working checklist. Source-derived items retain their quotations when edited; attorney-added items are explicitly marked as authored by the attorney. This record remains separate from agreed scope, canonical work completion, posted deadlines and payments. Submission review identifies possible issues in selected text for human review.

## File editing and transfer receipts

DOCX editing opens only for an active funded matter, an authorized current participant and a safe current file. The provider has signed source/callback access and an exact configured origin in CSP. Source versions and assignment authority are checked before recording a new LPC version. Saves use LPC's existing encryption, quarantine, malware checks, file history and transactions.

Provider editing/autosave is distinguished from a saved LPC version. The native Save to LPC command uses a client request nonce correlated through the signed callback. A timeout or uncertain acknowledgement keeps editing/recovery available. The interface never substitutes an elapsed timer or provider event for a confirmed LPC file receipt. The editor owns its full-viewport dialog geometry; the general confirmation-dialog adapter does not shrink it. Existing discard confirmation and focus return apply.

Clio transfers are explicit and pinned to the initiating LPC owner, current Clio connection revision, reviewed source-document versions and selected destination. Approved-file exports also pin the reviewed LPC file version. Source descriptions and selected-document details remain encrypted private handoff data. Public posting content comes only from the attorney-authored and reviewed brief. An existing funded matter can receive a direct handoff without creating a duplicate posting.

Durable import/export receipts preserve original operation identity across refresh, reconnect and lost acknowledgements. Recovery checks the saved transfer, rather than silently making another external upload. Disconnect and provider-account changes invalidate stale selections. Clio custom-action parameters are removed from the address bar after capture; an uncertain nonce acknowledgement uses an explicit authorized read to recover the selected matter.

## Matching and account boundaries

Matching indexes only approved, visible public professional profile fields. Private documents, resumes, matter content and communications are excluded. Embeddings are cached by public profile content in MongoDB. Ranking is bounded to 500 filtered profiles; it needs no separate vector database. A related-term/profile-evidence fallback remains available when the embedding service is unavailable, and the response states the fallback.

Experience is self-reported; the UI exposes the supporting profile text and requirements that still need confirmation. Profile visibility, blocking, availability and applicable hard requirements are rechecked after ranking. Existing profile, save, invitation and application flows remain the decision points. Search never automatically invites, selects, applies, hires or moves money.

Native API requests verify the current approved owner and role before and after operations, use fresh CSRF protection for mutations, and abort with the route. Session/account loss delegates to the existing portal cleanup. Matter purge removes preparation jobs/results, editor sessions, direct/draft Clio handoffs and transfer records. Account deactivation/minimization also removes pending job actor context, tokens, vectors and editing sessions under the existing retention workflow.

## Activation

Use the environment's existing MongoDB, authentication, S3, KMS/encryption and malware configuration. Credentials belong in the deployment's secret configuration.

1. **Preparation and matching:** existing `OPENAI_API_KEY` and AI configuration. `OPENAI_MATCH_EMBEDDING_MODEL` optionally selects the embedding model. Without the AI provider, preparation reports its unavailable state and normal Work/Files remain usable; matching uses its explicit fallback.
2. **Scanned PDFs:** a versioned S3 bucket in `us-east-1`, `us-east-2` or `us-west-2`, using the existing S3 region/credentials. The application role needs `textract:StartDocumentTextDetection` and `textract:GetDocumentTextDetection`, plus authorized `s3:GetObjectVersion`/object access and applicable KMS decryption for the existing file prefix. Textract permissions use resource `*`; keep storage/KMS permissions limited to LPC's existing confidential document scope. Verify with a synthetic scanned PDF before confidential use. Missing permissions, unsupported locations and unversioned objects produce an explicit reading failure; they do not appear as complete coverage.
3. **DOCX collaboration:** see [document collaboration activation](CONNECTED_DOCUMENT_COLLABORATION.md). Requires an appropriately licensed ONLYOFFICE deployment, `ONLYOFFICE_DOCUMENT_SERVER_URL`, `ONLYOFFICE_JWT_SECRET`, and an `APP_BASE_URL` reachable by it. Production uses HTTPS and the existing confidential-storage encryption policy.
4. **Clio:** see [Clio activation](CLIO_CONNECTED_WORKSPACE.md). Requires the US developer app, applicable permissions/distribution approval, `CLIO_CLIENT_ID`, `CLIO_CLIENT_SECRET`, and the exact configured redirect URI.
5. Rehearse with synthetic matters in staging: both roles, a scanned PDF, accepted edited checklist, co-edit/save and file-history receipt, selected Clio import, approved export, provider failure, session/account switch, disconnect and revoked access. Check representative legal Word layout fidelity with the actual document service.

Implementation and test fixtures are in this review branch. Production provider accounts, commercial licensing, live interoperability and deployment require the actual environment and have not been activated by this change.

## Verification

Focused database suites cover preparation, durable background jobs, matching, document collaboration, Clio and account/matter cleanup. Independent checks cover OCR pagination/partial results/version pinning, policy parsers and the native API's ownership, path and CSRF boundaries. Browser journeys serve the actual LPC portals with controlled synthetic API/provider responses; fixtures are restricted to tests. They cover desktop/mobile navigation, source escaping, editable checklist review, exact-request recovery, native document save receipts, profile round trips and Clio review dialogs.

The checks and their results for the final branch head are recorded in the pull request. Existing repository baseline failures are identified separately and are not relabeled as regressions or silently disabled.

## Primary provider references

- [Amazon Textract StartDocumentTextDetection](https://docs.aws.amazon.com/textract/latest/dg/API_StartDocumentTextDetection.html)
- [Amazon Textract GetDocumentTextDetection](https://docs.aws.amazon.com/textract/latest/dg/API_GetDocumentTextDetection.html)
- [ONLYOFFICE Docs API](https://api.onlyoffice.com/docs/docs-api/)
- [ONLYOFFICE callback handler](https://api.onlyoffice.com/docs/docs-api/usage-api/callback-handler/)
- [Clio Manage API](https://docs.developers.clio.com/clio-manage/api-reference/)
- [Clio custom actions](https://docs.developers.clio.com/guides/clio-manage/custom-actions/)

## Current portal presentation

Connected features inherit the current authenticated portal system fonts and native colors. They use flat white sections, rows and neutral separators. No global theme override, historical gold/cream palette, serif UI headings or enclosing cards are added. Existing portal/header/matter layout files must be preserved when integrating into a newer local checkout. Clio retains its official symbol and outlined wordmark without a partnership claim.
