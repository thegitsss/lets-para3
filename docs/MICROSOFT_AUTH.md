# Microsoft sign-up and sign-in

Scope: an additional authentication option for personal Microsoft accounts and organizational Microsoft 365 accounts. This grants no access to mail, calendars, contacts, files or other Microsoft Graph resources. LPC application review, qualifications, documents, fees, email-verification policy, MFA and session rules remain authoritative. Apple is not included.

## Microsoft app registration

Use an owner-controlled Microsoft account with access to a workforce Microsoft Entra tenant and app registrations. Microsoft account creation, password creation, identity verification and any required agreements must be completed by the owner. Do not purchase a plan or subscription as part of this implementation without separate authorization.

Create an app named **Let’s-ParaConnect** with supported account types **Any Entra ID Tenant + Personal Microsoft accounts** (AzureADandPersonalMicrosoftAccount). Configure a **Web** platform, not SPA, and register:

- `https://www.lets-paraconnect.com/api/auth/microsoft/callback`
- `http://localhost:5051/api/auth/microsoft/callback`

Use the authorization-code flow. Implicit grant, public-client flows, Graph resource permissions and offline access are unnecessary. The application requests only `openid email profile`. Preserve existing Google and LinkedIn configuration.

Configure the target environment privately:

```
MICROSOFT_AUTH_CLIENT_ID=<Application client ID>
MICROSOFT_AUTH_CLIENT_SECRET=<client secret value>
MICROSOFT_AUTH_REDIRECT_URI=<the exact callback for this environment>
```

Never paste the secret into chat, commit it, place it in frontend code, or reuse LinkedIn/Google credentials. The secret's expiry needs to be tracked and renewed. Production configuration and deployment require separate authorization. Unconfigured environments return a friendly unavailable message rather than redirecting to a misconfigured provider.

## Identity and email safety

- Authorization code with PKCE S256, nonce, signed HttpOnly state cookie and an exact callback. Requests use Microsoft's fixed `common` authority for both account types.
- The RS256 ID token is verified using fixed Microsoft JWKS metadata; signing-key issuer, token issuer, tenant GUID, audience, version, issuance/expiry and nonce are checked. Tenant identifiers never choose a network endpoint.
- Provider identities use `tenant ID:subject`; identical subjects in different tenants cannot identify the same LPC account. Microsoft email claims are suggestions, never proof of ownership or identity keys.
- A new applicant can confirm/edit their suggested email or supply one if Microsoft omits it. LPC sends its own verification email and keeps the application pending. Required professional information and documents remain required.
- A matching existing email requires proof through the existing LPC password/MFA flow before linking. Linking retains transaction rollback and the provider's uniqueness constraint.
- Linked accounts retain disabled-account, maintenance, approval, current approved-member email policy and MFA checks. Tokens are neither persisted nor logged.
- Some organizations require administrator consent or prohibit third-party applications. LPC must respect those policies; existing sign-in alternatives remain available.

## Evidence boundary

Provider JWT tests use isolated RSA keys; callback/linking tests use mocked provider responses and temporary MongoDB. Rendered checks use the exact localhost:5051 pages, with synthetic return responses where indicated. These do not establish real Microsoft consent, tenant setup, organization-wide compatibility or production deployment.

Primary references: [authorization code and PKCE](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-auth-code-flow), [token/key issuer and tenant validation](https://learn.microsoft.com/en-us/entra/identity-platform/access-tokens), [email claim limitations](https://learn.microsoft.com/en-us/entra/identity-platform/id-token-claims-reference), [app registration](https://learn.microsoft.com/en-us/entra/identity-platform/quickstart-register-app).
