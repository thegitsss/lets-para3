# LPC connected workspace

Controlling product direction: [LPC Product North Star](LPC_PRODUCT_NORTH_STAR.md). These additions preserve LPC’s existing appearance, matter lifecycle, funding boundary, file authority, and attorney decisions.

## Delivered code

| Capability | Entry point | Implementation |
| --- | --- | --- |
| Matter preparation and submission checks | Work/Files → Prepare workspace; /matter-tools.html?caseId=… | Reads selected source documents, proposes a working checklist and clarification/review observations with literal source quotations. Attorney can edit and accept the working aid. Does not amend agreed scope or mark work complete. |
| DOCX collaboration | Matter preparation → Work on a document; /document-editor.html?caseId=…&fileId=… | ONLYOFFICE integration with co-editing, comments, tracked changes, signed source delivery, guarded callbacks, recoverable LPC file versions and existing malware checks. |
| Clio connection | /clio-connect.html, including from a funded Matter | US OAuth, selected private handoffs, selected funded imports, approved-file exports and an optional action inside Clio. |
| Evidence-based matching | Find a Paralegal → Find by experience; /paralegal-match.html | Current visible professional profile evidence, exact required-skill filters, experience/availability filters, keyword/related-term ranking and configured-provider semantic ranking with cached vectors. No raw resumes or private matter work are indexed. |

All four backend routers are mounted by backend/index.js. New standalone pages use the existing Sarabun/Cormorant typography and LPC palette. Existing portal layouts remain in place.

## Authority and privacy

- Preparation and collaboration require a currently approved actor and an active funded matter. Existing revocation, current-assignment visibility, read-only, completion and dispute boundaries apply.
- Preparations are encrypted at rest and scoped to the current attorney/paralegal assignment. A replacement paralegal cannot inherit a previous assignment’s preparation.
- A source quotation must be an exact substring of a selected source section. PDF citations identify a page; DOC/DOCX/TXT citations identify an extracted text section, not a fabricated page.
- Source versions and scope are checked again after processing. A changed source, security restriction, assignment, or scope requires fresh preparation.
- An accepted working checklist is separate from contractual scope and authoritative completion tasks. Editing it does not authorize additional work or money movement.
- Clio source matter descriptions and selected-document context stay in encrypted private handoff records. The separate posting draft starts blank, avoiding accidental publication of client details. The attorney authors and reviews the public scope.
- Clio transfers require the initiating LPC account and selected Clio connection revision. Reconnecting to another provider account invalidates an old selection.
- Matching rechecks profile visibility and blocking after processing. Recommendations never select, apply, invite, hire, fund or release payments. Arbitrary mandatory Matter requirements still require the existing confirmation process.
- Account deactivation/minimization removes connection credentials, cached profile vectors and editing sessions. Draft deletion removes its private Clio handoff in the same transaction. Existing Matter purge also removes derived preparations and connected-workspace records.

## Limits and truthful fallback

Preparation accepts up to eight readable PDF, DOC, DOCX or TXT files, each up to 10 MB. PDFs are limited to 80 pages and one request to 180,000 extracted characters. Password-protected, malformed and image-only documents cannot be treated as fully read. Unreadable PDF pages are explicitly reported. OCR for image-only content is not implemented in this version.

Without the configured AI provider, preparation reports unavailable and retains normal Files/Work access. Matching remains usable through profile evidence and related work terms; if semantic ranking fails, the response states that fallback. At LPC’s current size the service ranks a bounded set (up to 500 filtered profiles) using cached vectors stored in MongoDB. It does not require a paid Atlas vector index, a separate vector database, training on completed matters, or a migration of resumes.

Document collaboration supports DOCX. Existing LPC file history is the revision authority. The provider’s separate history ZIP/viewer is not integrated. Complex Word layout fidelity still requires a paired provider rehearsal with representative legal documents before activation.

Provider requests and external document transfers are implemented but were not exercised against live customer accounts during this work. Test fixtures exist only in tests; runtime adapters report missing configuration honestly.

## Configuration and activation

Use the current environment’s existing MongoDB, authentication, S3, KMS/encryption, malware-scanning and notification configuration. Never copy production credentials into tests or GitHub.

1. **Preparation and semantic matching:** existing OPENAI_API_KEY and the existing AI model configuration. OPENAI_MATCH_EMBEDDING_MODEL optionally selects the embedding model. Review the existing provider budget/data-handling configuration and verify costs with bounded synthetic samples before sending confidential documents.
2. **Document collaboration:** see [document collaboration activation](CONNECTED_DOCUMENT_COLLABORATION.md). Requires an appropriately licensed ONLYOFFICE service, ONLYOFFICE_DOCUMENT_SERVER_URL, ONLYOFFICE_JWT_SECRET, and an APP_BASE_URL reachable by that service. Production uses HTTPS and the existing confidential-storage encryption policy. CSP allows only the configured editor origin.
3. **Clio:** see [Clio activation](CLIO_CONNECTED_WORKSPACE.md). Requires the US developer app, current permissions, CLIO_CLIENT_ID, CLIO_CLIENT_SECRET, an exact redirect URI and applicable Clio distribution approval.
4. Rehearse both roles using synthetic matters: hire/fund through the existing workflow; prepare and accept a checklist; co-edit and save a DOCX; review its new LPC version; select an explicit Clio import; approve a deliverable and export it. Test disconnect, account switch, revoked access and a provider failure.

No provider subscription was purchased, no production configuration was changed, and no production deployment was performed as part of this branch.

## Verification

Focused suites:

- connectedMatching.test.js, connectedPreparation.test.js, connectedPolicies.test.js
- documentCollaboration.test.js, documentCollaborationPolicy.test.js
- clioIntegration.test.js, clioPolicy.test.js

Independent parser tests use actual synthetic PDF, DOCX and TXT files, including malformed-file rejection. Database suites exercise authorization, confidentiality, stale sources, account changes, imports/exports, duplicate callbacks, encrypted storage, transactional saves and replay recovery.

The execution host initially could not start the default Mongo test process. A scratch-only wrapper around the existing global setup used MongoDB 7.0.14 with a workspace database path, --nounixsocket and diagnosticDataCollectionEnabled=false. This exercised the same application and transaction suites without modifying the repository’s normal harness or production database settings.

Executed verification: 86 feature database checks (matching 14, preparation 20, editor 21, Clio 31), 4 connected-lifecycle checks, 51 existing account/draft regressions, 41 isolated policy/parser checks, and 9 browser journeys: 191 passing checks in total. Browser journeys used actual served frontend files and synthetic API/provider fixtures, including source HTML escaping, missing-provider recovery, attorney/paralegal differences, narrow layouts and keyboard navigation.

The frontend build, API contract, route uniqueness, whitespace checks and binding checks for the new runtime files passed. The full syntax check parsed 1,819 JavaScript files. Two broader pre-existing checks remain failing: the original branch has the same 100 frontend-hygiene findings and the same unmounted waitlist route flagged by the static route-security inventory. Comparison against a separate checkout of the exact base commit found no new frontend-hygiene findings and no additional open mutating routes from these changes.

Provider activation, live compatibility and production deployment are separate from tested code implementation. This is a review branch, not a new production release certification.

## Primary integration references

- [ONLYOFFICE Docs API](https://api.onlyoffice.com/docs/docs-api/)
- [ONLYOFFICE callback handler](https://api.onlyoffice.com/docs/docs-api/usage-api/callback-handler/)
- [Clio Manage API](https://docs.developers.clio.com/clio-manage/api-reference/)
- [Clio custom actions](https://docs.developers.clio.com/guides/clio-manage/custom-actions/)
- [Clio public/private application requirements](https://docs.developers.clio.com/api-docs/clio-platform/applications/)

Verify commercial licensing, current prices, account permissions and distribution conditions with each provider before activation. Current source and observed provider behavior govern implementation choices.
