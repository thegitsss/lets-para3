const fs = require("fs");
const path = require("path");

const {
  AUTH_PROVIDER_TIMEOUT_MS,
  createGoogleOAuthClient,
  verifyTurnstileToken,
} = require("../services/authProviderClient");
const {
  OPENAI_MAX_RETRIES,
  OPENAI_TIMEOUT_MS,
  buildOpenAIClientOptions,
} = require("../ai/config");
const {
  S3_CONNECTION_TIMEOUT_MS,
  S3_MAX_ATTEMPTS,
  S3_REQUEST_TIMEOUT_MS,
  S3_SOCKET_TIMEOUT_MS,
  buildS3ClientConfig,
  createS3Client,
} = require("../utils/s3Client");

const backendRoot = path.resolve(__dirname, "..");

function runtimeJavaScriptFiles(directory) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (["node_modules", "tests", "test-results"].includes(entry.name)) continue;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...runtimeJavaScriptFiles(absolute));
    else if (entry.isFile() && entry.name.endsWith(".js")) files.push(absolute);
  }
  return files;
}

describe("bounded outbound network policy", () => {
  test("applies explicit deadlines and bounded attempts to every S3 client", () => {
    const config = buildS3ClientConfig({
      S3_REGION: "us-east-2",
      S3_ACCESS_KEY: " access-key ",
      S3_SECRET_KEY: " secret-key ",
      S3_SESSION_TOKEN: " session-token ",
    });

    expect(config).toEqual({
      region: "us-east-2",
      credentials: {
        accessKeyId: "access-key",
        secretAccessKey: "secret-key",
        sessionToken: "session-token",
      },
      maxAttempts: S3_MAX_ATTEMPTS,
      requestHandler: {
        connectionTimeout: S3_CONNECTION_TIMEOUT_MS,
        requestTimeout: S3_REQUEST_TIMEOUT_MS,
        socketTimeout: S3_SOCKET_TIMEOUT_MS,
        throwOnRequestTimeout: true,
      },
    });
    expect(config.maxAttempts).toBe(3);
    expect(config.requestHandler.connectionTimeout).toBe(10_000);
    expect(config.requestHandler.requestTimeout).toBe(120_000);
    expect(config.requestHandler.socketTimeout).toBe(30_000);
  });

  test("rejects partial S3 credentials instead of silently changing credential sources", () => {
    expect(() => buildS3ClientConfig({ S3_ACCESS_KEY: "only-one-half" })).toThrow(/configured together/i);
    expect(buildS3ClientConfig({ S3_REGION: "us-west-2" }).credentials).toBeUndefined();
  });

  test("passes the deadline policy into the AWS SDK Node HTTP handler", async () => {
    const client = createS3Client({ S3_REGION: "us-east-1" });
    try {
      // NodeHttpHandler materializes its public config only on first request; its
      // provider is the authoritative pre-request configuration used by handle().
      const handlerConfig = await client.config.requestHandler.configProvider;
      expect(handlerConfig.connectionTimeout).toBe(S3_CONNECTION_TIMEOUT_MS);
      expect(handlerConfig.requestTimeout).toBe(S3_REQUEST_TIMEOUT_MS);
      expect(handlerConfig.socketTimeout).toBe(S3_SOCKET_TIMEOUT_MS);
      expect(handlerConfig.throwOnRequestTimeout).toBe(true);
    } finally {
      client.destroy();
    }
  });

  test("keeps direct S3 construction behind the shared bounded client", () => {
    const offenders = runtimeJavaScriptFiles(backendRoot)
      .filter((file) => file !== path.join(backendRoot, "utils", "s3Client.js"))
      .filter((file) => /new\s+S3Client\s*\(/.test(fs.readFileSync(file, "utf8")))
      .map((file) => path.relative(backendRoot, file));
    expect(offenders).toEqual([]);
  });

  test("bounds Google OAuth and Turnstile verification and fails Turnstile closed", async () => {
    const OAuthClient = jest.fn((options) => ({ options }));
    const googleClient = createGoogleOAuthClient(
      { clientId: "client", clientSecret: "secret", redirectUri: "https://app.test/callback" },
      OAuthClient
    );
    expect(googleClient.options.transporterOptions.timeout).toBe(AUTH_PROVIDER_TIMEOUT_MS);

    const axiosClient = {
      post: jest.fn().mockRejectedValue(Object.assign(new Error("provider timeout"), { code: "ECONNABORTED" })),
    };
    const logger = { error: jest.fn() };
    await expect(
      verifyTurnstileToken({ secret: "secret", token: "token", remoteIp: "203.0.113.1", axiosClient, logger })
    ).resolves.toEqual({ success: false, errorCodes: ["verify-error"] });
    expect(axiosClient.post).toHaveBeenCalledWith(
      "https://challenges.cloudflare.com/turnstile/v0/siteverify",
      expect.any(URLSearchParams),
      { timeout: AUTH_PROVIDER_TIMEOUT_MS }
    );
    expect(logger.error).toHaveBeenCalledTimes(1);
  });

  test("binds successful Turnstile tokens to the LPC signup action and hostname", async () => {
    const response = {
      success: true,
      action: "signup",
      hostname: "www.lets-paraconnect.com",
      "error-codes": [],
    };
    const axiosClient = { post: jest.fn().mockResolvedValue({ data: response }) };
    const input = {
      secret: "secret",
      token: "token",
      axiosClient,
      expectedAction: "signup",
      expectedHostname: "www.lets-paraconnect.com",
    };

    await expect(verifyTurnstileToken(input)).resolves.toEqual(response);
    await expect(
      verifyTurnstileToken({ ...input, expectedAction: "password-reset" })
    ).resolves.toMatchObject({ success: false, errorCodes: ["action-mismatch"] });
    await expect(
      verifyTurnstileToken({ ...input, expectedHostname: "attacker.example" })
    ).resolves.toMatchObject({ success: false, errorCodes: ["hostname-mismatch"] });
    await expect(
      verifyTurnstileToken({ ...input, expectedHostname: "" })
    ).resolves.toMatchObject({ success: false, errorCodes: ["binding-missing"] });
  });

  test("declares the signup action in the widget and contains no production email bypass", () => {
    const signup = fs.readFileSync(path.resolve(backendRoot, "../frontend/signup.html"), "utf8");
    const authRoute = fs.readFileSync(path.resolve(backendRoot, "routes/auth.js"), "utf8");
    expect(signup).toMatch(/class="cf-turnstile"[\s\S]{0,300}data-action="signup"/);
    expect(authRoute).not.toMatch(/DEV_BYPASS_EMAILS|bypassCaptcha|captchaToken|recaptchaToken/);
  });

  test("bounds the default OpenAI client and its retries", () => {
    expect(buildOpenAIClientOptions("api-key")).toEqual({
      apiKey: "api-key",
      timeout: OPENAI_TIMEOUT_MS,
      maxRetries: OPENAI_MAX_RETRIES,
    });
    expect(OPENAI_TIMEOUT_MS).toBe(30_000);
    expect(OPENAI_MAX_RETRIES).toBe(2);
  });
});
