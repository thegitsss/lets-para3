# LPC Route Security Pass Evidence

This document records the current, reproducible mutating-route security gate. It intentionally contains no workspace-specific `git status`, transient timestamp, or historical line counts.

## Source of truth

- Generator: `backend/scripts/route-security-inventory.js`
- Generated inventory: `docs/LPC_ROUTE_SECURITY_INVENTORY.md`
- Run from the repository root: `node backend/scripts/route-security-inventory.js`

Current result:

```json
{
  "total": 203,
  "counts": {
    "verified": 196,
    "exempt": 7
  },
  "open": 0,
  "exemptions": 7
}
```

The generator inventories every literal `router.post`, `router.put`, `router.patch`, and `router.delete` declaration under `backend/routes`. Any `open` result is a launch blocker until the route is protected or its exemption is documented in code.

## Narrow exemptions

- Stripe webhook intake is authenticated with Stripe raw-body signature verification; browser CSRF does not apply.
- Five control-room E2E bootstrap/seed routes are mounted only when the production-forbidden harness gate is explicitly enabled and also require the harness secret.
- Web Vitals intake is anonymous, same-origin telemetry. It accepts only bounded allowlisted metrics, stores no session/user identity, and has a dedicated 30-request-per-minute limit.

There are no public-auth or lead-capture routes in exemption review. Logout is CSRF-protected. The unused waitlist mail endpoint was removed.

## Behavioral and static regression evidence

Run from `backend` with the launch Node runtime:

```bash
node ./node_modules/jest/bin/jest.js tests/csrf.test.js tests/securityEdgeCases.test.js --runInBand
node scripts/test-auth-fetch-ui.js
npm run check:routes
npm run check:route-security
npm run check:syntax
npm run check:frontend
```

These checks establish that:

- csurf failures produce HTTP 403 with stable code `CSRF_INVALID`;
- only explicit CSRF failures refresh and retry, exactly once;
- ordinary authorization failures are never double-submitted;
- HTTP 403 preserves a valid session, HTTP 401 clears it, and HTTP 428 enters legal re-acceptance;
- mutating route declarations remain unique;
- frontend modules and references remain syntactically valid and reachable.

The full release record must still link the exact commit and CI run; this source document alone is not a production go/no-go approval.
