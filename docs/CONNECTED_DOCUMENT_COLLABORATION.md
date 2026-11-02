# Connected document collaboration

This implementation follows `LPC_PRODUCT_NORTH_STAR.md`: it extends Files and preserves existing authentication, funded-Matter boundaries, storage quarantine, original documents, review decisions, and recoverable history. It does not activate a document service or transmit production documents during development.

## API and interface

Mount `backend/routes/documentCollaboration.js` at `/api/document-collaboration`. The user interface opens a session using `POST /matters/:caseId/files/:fileId/session` with the ordinary LPC cookie and CSRF token, then loads the returned `scriptUrl` and constructs `new DocsAPI.DocEditor(elementId, result.config)`. Both participants receive the same document key for the same active editing session. `expectedOwnerId` may be supplied and must match the current account.

`GET /status` reports whether the provider is configured. It never returns credentials. `GET /sessions/:sessionId` returns the current save state and actual saved version. A displayed editor or a provider-side autosave alone is not confirmation that LPC recorded a version.

Provider source and callback routes deliberately do not use cookie authentication or CSRF. The source URL carries a signed, time-limited, session-and-actor-bound token. Every source fetch rechecks the active approved account, current assignment, funded Matter, retained file reference, malware clearance, and stored object ETag/version. Provider callbacks require a valid ONLYOFFICE JWT; an ordinary account token or editor configuration token does not authorize a callback. Callback parameters are read from the verified signature, never from unsigned substitute body fields.

## Configuration

- `ONLYOFFICE_DOCUMENT_SERVER_URL`: the exact HTTPS origin of the licensed/configured document server. An HTTP loopback origin is accepted only outside production. Subpath deployments are not supported by this first integration.
- `ONLYOFFICE_JWT_SECRET`: at least 32 characters, matching the document server's JWT configuration. Never expose the raw secret to the browser or logs.
- `APP_BASE_URL`: the existing LPC application origin, reachable by the document server. Production requires HTTPS.
- Existing `S3_BUCKET`, authentication, encryption, and `S3_SSE_KMS_KEY_ID` requirements remain in force. Document bytes use the existing confidential-storage encryption policy.
- Add the exact configured editor origin to the page's script/frame/connect CSP directives. Do not add wildcards or disable CSP.

The first supported format is DOCX, at most 20 MB. Other files remain accessible through the normal Files experience. No commercial license entitlement, hosting location, or provider approval is inferred from the availability of an API or a trial.

## Saving and recovery

ONLYOFFICE status 6 saves a version while co-editing continues; status 2 saves and closes the editing session. Each save writes a new quarantined S3 object. A transaction fences the current Matter, checks the file revision, retains the earlier key in `CaseFile.history`, advances the file version, resets the file to pending review, records the upload and audit, and stores a save receipt together. The original bytes are never overwritten or deleted by this integration. Current file security checks still apply after saving.

Duplicate callbacks use retained receipts. An older callback cannot revert a newer save. Redirects and downloads outside the exact document-server origin are rejected; byte count and download time are bounded. Account revocation, assignment changes, completion claims, and external file replacement prevent late saves. A lost transaction acknowledgement is checked against the transactional receipt before an error is returned.

Unconfirmed attempts remain in the existing upload reconciliation system. The interface must state that saving could not be confirmed and tell the user to retain or download a copy from the editor and inspect Files. It must not display a successful save on an unconfirmed callback. A session expiration requires reopening from Files.

Version history is available through LPC's existing document history. The first integration does not embed the provider's separate revision-history viewer or its change-history ZIP files; native tracked changes and comments remain in saved DOCX content. Do not claim those provider-history features are verified.

## Validation and activation

`tests/documentCollaboration.test.js` exercises real Mongo transactions with synthetic documents and mocked storage/provider transport, including access boundaries, co-editing keys, source signatures, JWT purpose separation, callback-origin enforcement, original retention, status-2/status-6 saving, replay handling, account changes during save, and lost commit acknowledgements. `tests/documentCollaborationPolicy.test.js` can run without the Mongo global harness to verify signature, configuration, URL, and byte-limit policies.

These tests are not a live ONLYOFFICE certification. Before production activation, configure an appropriately licensed U.S. deployment, verify application/document-server mutual reachability and CSP, and run paired attorney/paralegal editing with representative legal DOCX documents containing tables, numbering, footnotes, headers, comments, and tracked changes. Confirm both saves and downloads preserve those documents' required formatting and that access loss and save recovery behave as documented. Record actual licensing/hosting costs rather than assuming a free embedded commercial license.

Primary API references: [callback statuses](https://api.onlyoffice.com/docs/docs-api/usage-api/callback-handler), [body JWTs](https://api.onlyoffice.com/docs/docs-api/additional-api/signature/request/token-in-body), [header JWTs](https://api.onlyoffice.com/docs/docs-api/additional-api/signature/request/token-in-header), [review permissions](https://api.onlyoffice.com/docs/docs-api/get-started/how-it-works/reviewing), and [current review customization](https://api.onlyoffice.com/docs/docs-api/usage-api/config/editor/customization/customization-standard-branding).
