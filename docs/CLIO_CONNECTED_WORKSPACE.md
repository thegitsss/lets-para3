# Clio connection implementation and activation

The controlling product direction is [LPC Product North Star](LPC_PRODUCT_NORTH_STAR.md). This is an optional U.S. Clio Manage integration. It does not publish matters, select paralegals, fund work, accept deliverables, or release funds.

## Implemented paths

Mount `backend/routes/clioIntegration.js` at `/api/integrations/clio`.

- `GET /status`: configuration and connection state; no credentials.
- `POST /connect`: returns an authorization URL for the attorney to review in Clio.
- `GET /callback`: consumes an account- and session-bound OAuth state, then returns through the compatibility redirect into native Connections or the originating matter Files view.
- `DELETE /connection`: removes local credentials, invalidates pending authorizations, and attempts provider access-token deauthorization.
- `GET /matters?q=&cursor=` and `GET /matters/:clioMatterId/documents?cursor=`: the connected attorney's permitted Clio records.
- `POST /handoffs`: explicitly reviewed Clio source versions and a private encrypted snapshot, plus an attorney-authored public work brief that creates a draft in the existing LPC posting flow. Private source descriptions never populate the public posting.
- `GET /handoffs?caseId=`: original published-draft and direct handoffs for the owned LPC matter. Without `caseId`, returns the owner's recent handoffs.
- `POST /matters/:caseId/handoffs`: a reviewed private source selection linked directly to an existing active funded matter, without a duplicate posting.
- `GET /transfers?caseId=`: authoritative import/export receipts and exact-operation retry descriptors, scoped to the current account/matter.
- `POST /matters/:caseId/import`: explicitly selected original source versions, only after the linked LPC matter is funded and assigned. These use LPC's normal file ledger, transaction, storage quarantine, notification obligation, and current-assignment creation time.
- `POST /matters/:caseId/export`: an explicitly approved current LPC document to an explicitly chosen Clio matter. The exact source revision and request identity are retained. Replays reuse the recorded transfer, and lost document-creation acknowledgements require provider reconciliation instead of creating another document.
- `POST /custom-action`: registers the optional Clio matter menu action.
- `POST /action-context`: validates the Clio nonce and exact matter subject path. Merely supplying a Clio matter URL is not authorization.
- `GET /matters/:clioMatterId/context`: explicit read-only recovery after an uncertain custom-action nonce response; requires the original Clio user and current connection revision, and reauthorizes the provider matter read.

All mutations require the current `expectedOwnerId` and existing CSRF protection. Handoff, import, export and custom-action requests also require `expectedConnectionRevision` from the last status response. The server pins all provider calls in an operation to that connection revision, so a stale page cannot transfer records through a newly connected Clio account. Imports and exports additionally require `confirmed: true` and a stable `requestId` (16–100 letters, digits, underscores or hyphens). The client should retain that identity on an uncertain retry. A unique owner/direction/fingerprint index also recovers the same transfer when a refreshed page issues a new UUID. Accepted UUID aliases remain bound to their original inputs through a unique owner/request-alias index; they cannot later identify another document or destination. Import file receipts are independently bound to the source account, document, version and LPC matter. The service fails closed if these duplicate-protection indexes are missing. Up to ten documents can be selected in a handoff/import. Each file is bounded to 20 MB.

Clio source descriptions can identify clients or disclose legal information. They stay in encrypted private handoff records. They are intentionally not copied into publicly visible LPC postings. The attorney authors the public scope in the existing draft workflow.

## Required configuration

1. Create the U.S. Clio Manage developer application and obtain its application key/secret. Use the least Clio permissions needed for matters read, documents read/write and identity. The custom-action permission is optional unless its button is offered.
2. Set `CLIO_CLIENT_ID` and `CLIO_CLIENT_SECRET` through the existing secret configuration mechanism. Never put them in frontend files, source control, a browser URL, screenshots, or logs.
3. Keep `DATA_ENCRYPTION_KEY` configured. A connection cannot be created without working at-rest encryption.
4. Keep `APP_BASE_URL` on LPC's authoritative origin. Register the exact callback `${APP_BASE_URL}/api/integrations/clio/callback`; `CLIO_REDIRECT_URI` may specify only that same-origin path. HTTPS is required in production.
5. Existing S3 confidential-storage encryption and malware quarantine remain required. Import does not bypass a pending or failed scan. The document must clear the ordinary controls before any later preview, AI processing, editing, download, or export.
6. Provider transfers are limited to signed HTTPS U.S. Amazon S3 URLs returned by the authenticated Clio API. Redirects are not followed, and Clio bearer tokens are never forwarded to storage. Confirm the actual U.S. transfer host in the live rehearsal; do not loosen the boundary to arbitrary hosts.
7. Apply model indexes through the existing startup/deployment process before accepting traffic. Keep account-closure cleanup in the same release as connection activation.

The API minor version is explicitly pinned to `4.0.13`, documented as Clio's default when this work was prepared. Check Clio's supported versions during activation.

## Honest activation status

The adapter and isolated synthetic tests can be validated without any real credentials, client records, paid services, or production changes. Live OAuth, actual document transfers, real Clio scopes, the custom action, provider distribution approval and commercial terms remain unverified until a developer account and explicitly authorized synthetic test matter are available.

Public distribution to multiple firms requires Clio's public-app approval process. An internal/private developer application does not establish that approval. Do not expose a working connection to users before its actual provider readiness is verified.

LPC's disconnect deletes its stored access and refresh tokens. Clio documents that application-initiated deauthorization revokes only the supplied access token; to revoke the entire refresh grant, the user must also remove LPC from their Clio application settings. The UI returns this instruction even if the provider is temporarily unavailable.

## Source contracts

- [Clio Manage authorization, refresh and deauthorization](https://docs.developers.clio.com/api-docs/clio-manage/authorization/)
- [Clio Manage API reference and document upload/finalization](https://docs.developers.clio.com/clio-manage/api-reference/)
- [Clio's OpenAPI specification](https://docs.developers.clio.com/openapi.json)
- [Custom actions and nonce validation](https://docs.developers.clio.com/guides/clio-manage/custom-actions/)
- [Private application limitations](https://docs.developers.clio.com/handbook/getting-started/building-private-apps/)

The current OpenAPI document uses `PATCH /documents/{id}.json` to mark the selected upload version `fully_uploaded`. The initial provider `POST /documents.json`, signed storage `PUT`, and finalization are distinct steps. Clio's external cloud-drive document integrations are not exposed by the Clio document API and are outside this integration.
