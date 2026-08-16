const {
  assertAutomationConfiguration,
  assertIncidentWorkerConfiguration,
  assertOpsMonitorConfiguration,
} = require("../utils/workerProductionConfig");

function base() {
  return {
    NODE_ENV: "production",
    MONGO_URI: "mongodb+srv://example.invalid/lpc",
    DATA_ENCRYPTION_KEY: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    OPENAI_API_KEY: "sk-production-placeholder",
    OPENAI_SAFETY_SALT: "worker-safety-salt-with-at-least-32-bytes",
    EMAIL_DISABLE: "false",
    SMTP_HOST: "smtp.example.com",
    SMTP_PORT: "587",
    SMTP_SECURE: "false",
    SMTP_USER: "mailer@example.com",
    SMTP_PASS: "password",
    SMTP_FROM_EMAIL: "mailer@example.com",
    SMTP_FROM_NAME: "LPC",
  };
}

describe("production worker configuration", () => {
  test.each([
    ["incident runner", assertIncidentWorkerConfiguration],
    ["automation cron", assertAutomationConfiguration],
    ["operations monitor", assertOpsMonitorConfiguration],
  ])("%s requires exact release identity when running on Render", (_label, validate) => {
    expect(() => validate({ NODE_ENV: "production", RENDER: "true" }))
      .toThrow(/full RENDER_GIT_COMMIT/i);
  });

  test("incident runner validates authority and shutdown timing", () => {
    const env = {
      ...base(),
      INCIDENT_FOUNDER_APPROVER_EMAILS: "founder@example.com",
      INCIDENT_FOUNDER_ALERT_EMAILS: "oncall@example.com",
      INCIDENT_RUNNER_LOCK_MS: "240000",
      INCIDENT_RUNNER_SHUTDOWN_GRACE_MS: "270000",
    };
    expect(() => assertIncidentWorkerConfiguration(env)).not.toThrow();
    expect(() => assertIncidentWorkerConfiguration({ ...env, INCIDENT_RUNNER_SHUTDOWN_GRACE_MS: "200000" }))
      .toThrow(/lock window must be shorter/i);
  });

  test("automation cron fails closed when an enabled integration is unconfigured", () => {
    const env = {
      ...base(),
      S3_BUCKET: "lpc-private",
      S3_REGION: "us-east-1",
      S3_ACCESS_KEY: "access",
      S3_SECRET_KEY: "secret",
      FOUNDER_EMAIL: "founder@example.com",
      LINKEDIN_CLIENT_ID: "linkedin-id",
      LINKEDIN_CLIENT_SECRET: "linkedin-secret",
      LINKEDIN_OAUTH_REDIRECT_URI: "https://www.lets-paraconnect.com/callback",
      ZOHO_MAIL_REFRESH_TOKEN: "refresh",
      ZOHO_MAIL_CLIENT_ID: "zoho-id",
      ZOHO_MAIL_CLIENT_SECRET: "zoho-secret",
      DIRECTOR_SMTP_USER: "director@example.com",
      DIRECTOR_SMTP_PASS: "director-password",
    };
    expect(() => assertAutomationConfiguration(env)).not.toThrow();
    expect(() => assertAutomationConfiguration({ ...env, ZOHO_MAIL_REFRESH_TOKEN: "" }))
      .toThrow(/ZOHO_MAIL_REFRESH_TOKEN/i);
  });

  test("operations monitor requires durable state, backup evidence, and alert delivery", () => {
    const env = {
      ...base(),
      OWNER_ALERT_EMAILS: "owner@example.com",
      OPS_HEALTHCHECK_URL: "https://www.lets-paraconnect.com/api/health",
      ATLAS_PROJECT_ID: "0123456789abcdef01234567",
      ATLAS_CLUSTER_NAME: "lpc-production",
      ATLAS_CLIENT_ID: "atlas-id",
      ATLAS_CLIENT_SECRET: "atlas-secret",
      MONITOR_CHECK_WEBHOOKS: "true",
      MONITOR_REQUIRE_BACKUP: "true",
      MONITOR_PERSIST_STATE: "true",
      MONITOR_SEND_OWNER_ALERTS: "true",
    };
    expect(() => assertOpsMonitorConfiguration(env)).not.toThrow();
    expect(() => assertOpsMonitorConfiguration({ ...env, MONITOR_REQUIRE_BACKUP: "false" }))
      .toThrow(/MONITOR_REQUIRE_BACKUP=true/i);
  });
});
