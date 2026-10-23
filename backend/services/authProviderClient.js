const axios = require("axios");
const { OAuth2Client } = require("google-auth-library");

const AUTH_PROVIDER_TIMEOUT_MS = 10_000;

function createGoogleOAuthClient(config = {}, OAuthClient = OAuth2Client) {
  return new OAuthClient({
    clientId: config.clientId,
    clientSecret: config.clientSecret,
    redirectUri: config.redirectUri,
    transporterOptions: { timeout: AUTH_PROVIDER_TIMEOUT_MS },
  });
}

async function verifyTurnstileToken({
  secret = "",
  token = "",
  remoteIp = "",
  axiosClient = axios,
  logger,
  expectedAction = "",
  expectedHostname = "",
} = {}) {
  if (!secret) return { success: false, errorCodes: ["missing-secret"] };
  if (!token) return { success: false, errorCodes: ["missing-token"] };

  const params = new URLSearchParams();
  params.append("secret", secret);
  params.append("response", token);
  if (remoteIp) params.append("remoteip", remoteIp);

  try {
    const { data } = await axiosClient.post(
      "https://challenges.cloudflare.com/turnstile/v0/siteverify",
      params,
      { timeout: AUTH_PROVIDER_TIMEOUT_MS }
    );
    const verification = data && typeof data === "object" ? data : { success: false };
    if (!verification.success) return verification;

    const action = String(verification.action || "").trim();
    const hostname = String(verification.hostname || "").trim().toLowerCase().replace(/\.$/, "");
    const requiredAction = String(expectedAction || "").trim();
    const requiredHostname = String(expectedHostname || "").trim().toLowerCase().replace(/\.$/, "");
    let bindingError = "";
    if (!requiredAction || !requiredHostname) bindingError = "binding-missing";
    else if (action !== requiredAction) bindingError = "action-mismatch";
    else if (hostname !== requiredHostname) bindingError = "hostname-mismatch";

    if (bindingError) {
      return {
        ...verification,
        success: false,
        "error-codes": [bindingError],
        errorCodes: [bindingError],
      };
    }
    return verification;
  } catch (err) {
    logger?.error?.("[turnstile] verify error", err?.message || err);
    return { success: false, errorCodes: ["verify-error"] };
  }
}

module.exports = {
  AUTH_PROVIDER_TIMEOUT_MS,
  createGoogleOAuthClient,
  verifyTurnstileToken,
};
