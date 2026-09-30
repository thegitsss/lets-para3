const {
  assertProductionOriginConfiguration,
  PRODUCTION_JWT_AUDIENCE,
} = require("../utils/productionOrigin");

function productionEnv(overrides = {}) {
  const stripeSecretFixture = ["sk", "live", "productiontestkey"].join("_");
  const webhookSecretFixture = ["whsec", "productiontestsecret"].join("_");
  const connectWebhookSecretFixture = ["whsec", "connectproductiontestsecret"].join("_");
  return {
    NODE_ENV: "production",
    APP_BASE_URL: "https://www.lets-paraconnect.com",
    CLIENT_BASE_URL: "https://www.lets-paraconnect.com",
    FRONTEND_BASE_URL: "https://www.lets-paraconnect.com",
    PUBLIC_ORIGIN: "https://www.lets-paraconnect.com",
    EMAIL_BASE_URL: "https://www.lets-paraconnect.com",
    CORS_ORIGINS: "https://www.lets-paraconnect.com",
    MONGO_URI: "mongodb+srv://example.invalid/lpc",
    ENABLE_CSRF: "true",
    REQUIRE_AUTH_SESSION: "true",
    REQUIRE_DATA_ENCRYPTION: "true",
    ENABLE_TWO_FACTOR: "true",
    TURNSTILE_ENFORCED: "true",
    TURNSTILE_SECRET: "turnstile-production-test-secret",
    EMAIL_DISABLE: "false",
    MESSAGE_EMAIL_SUPPRESS_MINUTES: "120",
    GOOGLE_CLIENT_ID: "google-client-id",
    GOOGLE_CLIENT_SECRET: "google-client-secret",
    GOOGLE_REDIRECT_URI: "https://www.lets-paraconnect.com/api/auth/google/callback",
    WEBAUTHN_ORIGIN: "https://www.lets-paraconnect.com",
    WEBAUTHN_RP_ID: "www.lets-paraconnect.com",
    WEBAUTHN_RP_NAME: "Let's-ParaConnect",
    JWT_SECRET: "production-test-jwt-secret-value-32-bytes-minimum",
    JWT_ISSUER: "https://www.lets-paraconnect.com",
    JWT_AUDIENCE: PRODUCTION_JWT_AUDIENCE,
    DATA_ENCRYPTION_KEY: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    OPENAI_API_KEY: "sk-production-test-placeholder-key",
    OPENAI_SAFETY_SALT: "production-openai-safety-salt-at-least-32-bytes",
    OPENAI_SUPPORT_MANAGER_ENABLED: "true",
    OPENAI_ATTORNEY_MANAGER_ENABLED: "true",
    OPENAI_ATTORNEY_MANAGER_ROLLOUT_PERCENT: "100",
    OPENAI_ATTORNEY_MANAGER_ALLOWLIST: "",
    OPENAI_ATTORNEY_LEGACY_FALLBACK: "false",
    OPENAI_PARALEGAL_MANAGER_ENABLED: "false",
    OPENAI_PARALEGAL_MANAGER_ROLLOUT_PERCENT: "0",
    OPENAI_PARALEGAL_LEGACY_FALLBACK: "false",
    STRIPE_SECRET_KEY: stripeSecretFixture,
    STRIPE_PUBLISHABLE_KEY: "pk_live_productiontestkey",
    STRIPE_WEBHOOK_SECRET: webhookSecretFixture,
    STRIPE_CONNECT_WEBHOOK_SECRET: connectWebhookSecretFixture,
    STRIPE_WEBHOOK_ALERTS_ENABLED: "true",
    STRIPE_API_VERSION: "2026-07-29.dahlia",
    STRIPE_CONNECT_COUNTRY: "US",
    PLATFORM_FEE_ATTORNEY_PERCENT: "22",
    PLATFORM_FEE_PARALEGAL_PERCENT: "18",
    STRIPE_CONNECT_RETURN_URL: "https://www.lets-paraconnect.com/profile-settings.html?stripe=return",
    STRIPE_CONNECT_REFRESH_URL: "https://www.lets-paraconnect.com/profile-settings.html?stripe=refresh",
    STRIPE_CHECKOUT_SUCCESS_URL: "https://www.lets-paraconnect.com/dashboard-attorney.html?payment=success#funds",
    STRIPE_CHECKOUT_CANCEL_URL: "https://www.lets-paraconnect.com/dashboard-attorney.html?payment=cancel#funds",
    S3_MALWARE_SCAN_REQUIRED: "true",
    S3_BUCKET: "lpc-production-private-files",
    S3_REGION: "us-east-1",
    SMTP_HOST: "smtp.example.com",
    SMTP_PORT: "587",
    SMTP_SECURE: "false",
    SMTP_USER: "mailer@example.com",
    SMTP_PASS: "smtp-production-test-password",
    SMTP_FROM_EMAIL: "notifications@example.com",
    SMTP_FROM_NAME: "Let's-ParaConnect",
    OWNER_ALERT_EMAILS: "owner@example.com",
    FOUNDER_EMAIL: "founder@example.com",
    INCIDENT_FOUNDER_APPROVER_EMAILS: "founder@example.com",
    INCIDENT_FOUNDER_ALERT_EMAILS: "oncall@example.com",
    LINKEDIN_CLIENT_ID: "linkedin-client-id",
    LINKEDIN_CLIENT_SECRET: "linkedin-client-secret",
    LINKEDIN_OAUTH_REDIRECT_URI: "https://www.lets-paraconnect.com/api/admin/marketing/publishing/channel-connections/linkedin_company/oauth/callback",
    ZOHO_MAIL_REFRESH_TOKEN: "zoho-refresh-token",
    ZOHO_MAIL_CLIENT_ID: "zoho-client-id",
    ZOHO_MAIL_CLIENT_SECRET: "zoho-client-secret",
    DIRECTOR_SMTP_USER: "director@example.com",
    DIRECTOR_SMTP_PASS: "director-smtp-password",
    ...overrides,
  };
}

describe("production origin configuration", () => {
  test("accepts the canonical LPC HTTPS origin and Google callback", () => {
    expect(assertProductionOriginConfiguration(productionEnv())).toBe(
      "https://www.lets-paraconnect.com"
    );
  });

  test("fails clearly instead of falling back when the canonical origin is missing", () => {
    expect(() =>
      assertProductionOriginConfiguration(productionEnv({ APP_BASE_URL: "" }))
    ).toThrow(/APP_BASE_URL is required in production/i);
  });

  test("rejects localhost, wildcard CORS, and a mismatched Google callback in production", () => {
    expect(() =>
      assertProductionOriginConfiguration(
        productionEnv({ APP_BASE_URL: "http://localhost:5050" })
      )
    ).toThrow(/canonical production HTTPS origin/i);
    expect(() =>
      assertProductionOriginConfiguration(productionEnv({ CORS_ORIGINS: "*" }))
    ).toThrow(/cannot contain a wildcard/i);
    expect(() =>
      assertProductionOriginConfiguration(
        productionEnv({ GOOGLE_REDIRECT_URI: "http://localhost:5050/api/auth/google/callback" })
      )
    ).toThrow(/canonical production HTTPS origin/i);
  });

  test("requires launch-grade signing and encryption secrets", () => {
    expect(() => assertProductionOriginConfiguration(productionEnv({ JWT_SECRET: "short" })))
      .toThrow(/JWT_SECRET must contain at least 32 bytes/i);
    expect(() => assertProductionOriginConfiguration(productionEnv({ JWT_ISSUER: "" })))
      .toThrow(/JWT_ISSUER must be https:\/\/www\.lets-paraconnect\.com/i);
    expect(() => assertProductionOriginConfiguration(productionEnv({
      JWT_AUDIENCE: "another-application",
    }))).toThrow(/JWT_AUDIENCE must be lets-paraconnect-web/i);
    expect(() => assertProductionOriginConfiguration(productionEnv({ DATA_ENCRYPTION_KEY: "invalid" })))
      .toThrow(/DATA_ENCRYPTION_KEY must be a 32-byte/i);
  });

  test("requires fail-closed S3 malware scanning in production", () => {
    expect(() => assertProductionOriginConfiguration(productionEnv({ S3_MALWARE_SCAN_REQUIRED: "false" })))
      .toThrow(/S3_MALWARE_SCAN_REQUIRED must be true/i);
    expect(() => assertProductionOriginConfiguration(productionEnv({ S3_BUCKET: "" })))
      .toThrow(/S3_BUCKET must be a valid production bucket/i);
    expect(() => assertProductionOriginConfiguration(productionEnv({ S3_REGION: "" })))
      .toThrow(/S3_REGION must be a valid AWS region/i);
    expect(() => assertProductionOriginConfiguration(productionEnv({ S3_ACCESS_KEY: "key-only" })))
      .toThrow(/must be configured together/i);
  });

  test("requires live Stripe credentials and rejects an untested explicit API version", () => {
    expect(() => assertProductionOriginConfiguration(productionEnv({ STRIPE_SECRET_KEY: "sk_test_demo" })))
      .toThrow(/live-mode secret key/i);
    expect(() => assertProductionOriginConfiguration(productionEnv({ STRIPE_PUBLISHABLE_KEY: "pk_test_demo" })))
      .toThrow(/live-mode publishable key/i);
    expect(() => assertProductionOriginConfiguration(productionEnv({ STRIPE_WEBHOOK_SECRET: "" })))
      .toThrow(/STRIPE_WEBHOOK_SECRET is required/i);
    expect(() => assertProductionOriginConfiguration(productionEnv({ STRIPE_CONNECT_WEBHOOK_SECRET: "" })))
      .toThrow(/STRIPE_CONNECT_WEBHOOK_SECRET is required/i);
    expect(() => assertProductionOriginConfiguration(productionEnv({ STRIPE_WEBHOOK_ALERTS_ENABLED: "false" })))
      .toThrow(/STRIPE_WEBHOOK_ALERTS_ENABLED must be true/i);
    expect(() => assertProductionOriginConfiguration(productionEnv({ STRIPE_API_VERSION: "" })))
      .toThrow(/must match the tested SDK version/i);
    expect(() => assertProductionOriginConfiguration(productionEnv({ STRIPE_API_VERSION: "2024-06-20" })))
      .toThrow(/must match the tested SDK version/i);
    expect(() => assertProductionOriginConfiguration(productionEnv({
      STRIPE_CHECKOUT_SUCCESS_URL: "https://www.lets-paraconnect.com/billing-attorney.html?checkout=success",
    }))).toThrow(/STRIPE_CHECKOUT_SUCCESS_URL must be/i);
  });

  test("locks production fees to the percentages published to both user roles", () => {
    expect(() => assertProductionOriginConfiguration(productionEnv({
      PLATFORM_FEE_ATTORNEY_PERCENT: "25",
    }))).toThrow(/must match the published launch fee \(22%\)/i);
    expect(() => assertProductionOriginConfiguration(productionEnv({
      PLATFORM_FEE_PARALEGAL_PERCENT: "not-a-number",
    }))).toThrow(/must be a percentage from 0 to 100/i);
    expect(() => assertProductionOriginConfiguration(productionEnv({
      PLATFORM_FEE_PERCENT: "22",
    }))).toThrow(/PLATFORM_FEE_PERCENT is retired/i);
  });

  test("requires production auth, AI, email, alerting, and scheduler configuration", () => {
    expect(() => assertProductionOriginConfiguration(productionEnv({ ENABLE_CSRF: "false" })))
      .toThrow(/ENABLE_CSRF must be true/i);
    expect(() => assertProductionOriginConfiguration(productionEnv({ TURNSTILE_SECRET: "" })))
      .toThrow(/TURNSTILE_SECRET is required/i);
    expect(() => assertProductionOriginConfiguration(productionEnv({ DEV_BYPASS_EMAILS: "owner@example.com" })))
      .toThrow(/DEV_BYPASS_EMAILS must be empty/i);
    expect(() => assertProductionOriginConfiguration(productionEnv({
      APP_ENV: "staging",
      ENABLE_AI_CONTROL_ROOM_E2E_HARNESS: "true",
    }))).toThrow(/cannot identify a production web service as staging/i);
    expect(() => assertProductionOriginConfiguration(productionEnv({
      STAGING: "true",
    }))).toThrow(/cannot expose staging or preview environment identity/i);
    expect(() => assertProductionOriginConfiguration(productionEnv({
      ENABLE_CCO_AUTONOMY_HARNESS: "true",
    }))).toThrow(/ENABLE_CCO_AUTONOMY_HARNESS cannot be enabled/i);
    expect(() => assertProductionOriginConfiguration(productionEnv({
      EMAIL_SKIP_VERIFY: "true",
    }))).toThrow(/EMAIL_SKIP_VERIFY cannot be enabled/i);
    expect(() => assertProductionOriginConfiguration(productionEnv({ OPENAI_API_KEY: "" })))
      .toThrow(/OPENAI_API_KEY is required/i);
    expect(() => assertProductionOriginConfiguration(productionEnv({ OPENAI_SAFETY_SALT: "short" })))
      .toThrow(/OPENAI_SAFETY_SALT must contain at least 32 bytes/i);
    expect(() => assertProductionOriginConfiguration(productionEnv({
      MESSAGE_EMAIL_SUPPRESS_MINUTES: "0",
    }))).toThrow(/MESSAGE_EMAIL_SUPPRESS_MINUTES must be 120/i);
    expect(() => assertProductionOriginConfiguration(productionEnv({
      OPENAI_ATTORNEY_MANAGER_ENABLED: "",
    }))).toThrow(/must be explicitly set to true or false/i);
    expect(() => assertProductionOriginConfiguration(productionEnv({
      OPENAI_SUPPORT_MANAGER_ENABLED: "false",
      OPENAI_ATTORNEY_MANAGER_ENABLED: "false",
      OPENAI_ATTORNEY_MANAGER_ROLLOUT_PERCENT: "",
    }))).toThrow(/OPENAI_ATTORNEY_MANAGER_ROLLOUT_PERCENT must be an approved stage/i);
    expect(() => assertProductionOriginConfiguration(productionEnv({
      OPENAI_ATTORNEY_MANAGER_ROLLOUT_PERCENT: "37",
    }))).toThrow(/must be an approved stage/i);
    expect(() => assertProductionOriginConfiguration(productionEnv({
      OPENAI_ATTORNEY_MANAGER_ROLLOUT_PERCENT: "0",
      OPENAI_ATTORNEY_MANAGER_ALLOWLIST: "",
    }))).toThrow(/requires OPENAI_ATTORNEY_MANAGER_ALLOWLIST/i);
    expect(assertProductionOriginConfiguration(productionEnv({
      OPENAI_ATTORNEY_MANAGER_ROLLOUT_PERCENT: "0",
      OPENAI_ATTORNEY_MANAGER_ALLOWLIST: "internal@example.com",
    }))).toBe("https://www.lets-paraconnect.com");
    expect(assertProductionOriginConfiguration(productionEnv({
      OPENAI_SUPPORT_MANAGER_ENABLED: "false",
      OPENAI_ATTORNEY_MANAGER_ENABLED: "false",
      OPENAI_ATTORNEY_MANAGER_ROLLOUT_PERCENT: "0",
    }))).toBe("https://www.lets-paraconnect.com");
    expect(() => assertProductionOriginConfiguration(productionEnv({
      OPENAI_ATTORNEY_LEGACY_FALLBACK: "true",
    }))).toThrow(/OPENAI_ATTORNEY_LEGACY_FALLBACK must be false/i);
    expect(() => assertProductionOriginConfiguration(productionEnv({
      OPENAI_PARALEGAL_MANAGER_ENABLED: "true",
      OPENAI_PARALEGAL_MANAGER_ROLLOUT_PERCENT: "100",
    }))).toThrow(/must remain false until its production acceptance/i);
    expect(() => assertProductionOriginConfiguration(productionEnv({
      OPENAI_PARALEGAL_MANAGER_ROLLOUT_PERCENT: "",
    }))).toThrow(/OPENAI_PARALEGAL_MANAGER_ROLLOUT_PERCENT must be an approved stage/i);
    expect(() => assertProductionOriginConfiguration(productionEnv({ SMTP_PORT: "not-a-port" })))
      .toThrow(/SMTP_PORT must be an integer/i);
    expect(() => assertProductionOriginConfiguration(productionEnv({ OWNER_ALERT_EMAILS: "" })))
      .toThrow(/OWNER_ALERT_EMAILS must contain/i);
  });

  test("requires explicit storage credentials on Render", () => {
    expect(() => assertProductionOriginConfiguration(productionEnv({
      RENDER: "true",
      RENDER_GIT_COMMIT: "a".repeat(40),
    })))
      .toThrow(/Render requires S3_ACCESS_KEY/i);
    expect(assertProductionOriginConfiguration(productionEnv({
      RENDER: "true",
      RENDER_GIT_COMMIT: "a".repeat(40),
      S3_ACCESS_KEY: "render-access-key",
      S3_SECRET_KEY: "render-secret-key",
    }))).toBe("https://www.lets-paraconnect.com");
  });

  test("requires exact release identity on Render", () => {
    expect(() => assertProductionOriginConfiguration(productionEnv({
      RENDER: "true",
      S3_ACCESS_KEY: "render-access-key",
      S3_SECRET_KEY: "render-secret-key",
    }))).toThrow(/full RENDER_GIT_COMMIT/i);
  });

  test("rejects a passkey relying party outside the production domain", () => {
    expect(() => assertProductionOriginConfiguration(productionEnv({
      WEBAUTHN_ORIGIN: "https://passkeys.example.com",
    }))).toThrow(/WEBAUTHN_ORIGIN must use/i);
    expect(() => assertProductionOriginConfiguration(productionEnv({
      WEBAUTHN_RP_ID: "example.com",
    }))).toThrow(/WEBAUTHN_RP_ID/i);
  });

  test("rejects incident release stubs and incomplete auto-deploy configuration in production", () => {
    expect(() => assertProductionOriginConfiguration(productionEnv({
      INCIDENT_PREVIEW_DEPLOY_MODE: "stub",
    }))).toThrow(/INCIDENT_PREVIEW_DEPLOY_MODE must be disabled or webhook/i);
    expect(() => assertProductionOriginConfiguration(productionEnv({
      INCIDENT_PRODUCTION_DEPLOY_MODE: "workspace_sync",
    }))).toThrow(/INCIDENT_PRODUCTION_DEPLOY_MODE must be disabled or webhook/i);
    expect(() => assertProductionOriginConfiguration(productionEnv({
      INCIDENT_AUTO_DEPLOY_ENABLED: "true",
      INCIDENT_PREVIEW_DEPLOY_MODE: "disabled",
      INCIDENT_PRODUCTION_DEPLOY_MODE: "disabled",
    }))).toThrow(/requires webhook preview and production deploy modes/i);
  });

  test("requires secure webhook URLs when incident release webhooks are enabled", () => {
    expect(() => assertProductionOriginConfiguration(productionEnv({
      INCIDENT_PREVIEW_DEPLOY_MODE: "webhook",
    }))).toThrow(/INCIDENT_PREVIEW_DEPLOY_WEBHOOK_URL is required/i);
    expect(() => assertProductionOriginConfiguration(productionEnv({
      INCIDENT_PREVIEW_DEPLOY_MODE: "webhook",
      INCIDENT_PREVIEW_DEPLOY_WEBHOOK_URL: "http://localhost:9999/deploy",
    }))).toThrow(/canonical production HTTPS origin/i);
    expect(assertProductionOriginConfiguration(productionEnv({
      INCIDENT_PREVIEW_DEPLOY_MODE: "webhook",
      INCIDENT_PREVIEW_DEPLOY_WEBHOOK_URL: "https://deploy.example.com/preview",
    }))).toBe("https://www.lets-paraconnect.com");
  });

  test("leaves explicit localhost development behavior unchanged", () => {
    expect(
      assertProductionOriginConfiguration({
        NODE_ENV: "development",
        APP_BASE_URL: "http://localhost:5050",
        GOOGLE_REDIRECT_URI: "http://localhost:5050/api/auth/google/callback",
      })
    ).toBeNull();
  });
});
