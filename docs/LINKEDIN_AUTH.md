# LinkedIn sign-up and sign-in

LinkedIn OpenID Connect shares LPC's existing Google application, approval, account-linking, MFA, and managed-session flow. It imports verified email and name for an application; it does not approve an application, verify professional qualifications, or import a profile photo. Photo import remains a separate explicit action and photo-review flow.

## Configuration

Set `LINKEDIN_AUTH_CLIENT_ID`, `LINKEDIN_AUTH_CLIENT_SECRET`, and `LINKEDIN_AUTH_REDIRECT_URI` in the target environment. The client ID and secret fall back to the existing `LINKEDIN_CLIENT_ID` and `LINKEDIN_CLIENT_SECRET`. The redirect URI is deliberately explicit and never falls back to the marketing or photo callback.

Register the exact callback for each environment in the LinkedIn app:

- Production: `https://www.lets-paraconnect.com/api/auth/linkedin/callback`
- Local preview: `http://localhost:5051/api/auth/linkedin/callback`

Enable Sign In with LinkedIn using OpenID Connect (`openid profile email`). Preserve existing marketing and photo-import callback URLs. Production requires HTTPS. Local HTTP is accepted only on loopback outside production.

## Security contract

- Signed HttpOnly state cookie, bounded lifetime, and authorization-code exchange with the configured client secret and exact callback.
- RS256 ID-token verification against LinkedIn's fixed JWKS endpoint, current issuer `https://www.linkedin.com/oauth`, audience, expiry, issuance time, and authorized-party claims. Userinfo subject must match the signed subject; verified email is required.
- Existing linked accounts retain approval, disabled-account, maintenance, email policy, and two-factor checks. No session before those checks complete.
- Matching email alone never links accounts. The existing LPC password or MFA flow must prove access to that account; identity linking retains its transaction and unique-provider constraint.
- New identities receive a short-lived signup handoff only. Required application details, qualifications, documents, policy acknowledgments, and pending approval remain in force.
- Tokens and provider error details are not returned to the browser or written to logs. Profile photos are not silently imported.

Internal shared handoff/link/MFA cookie names retain the existing `google` prefix for compatibility, with a validated provider discriminator. The OAuth state cookie is separate per provider.

## Verification boundary

Automated provider and callback tests use isolated keys, mocked provider responses, and temporary MongoDB. Rendered button checks use local pages. These do not prove an actual LinkedIn user-consent round trip, hosted provider configuration, or a production deployment.
