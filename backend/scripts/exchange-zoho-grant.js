const fs = require("fs");
const https = require("https");
const path = require("path");
const readline = require("readline");

require("dotenv").config({ path: path.join(__dirname, "..", ".env"), quiet: true });

const accountsBaseUrl = String(process.env.ZOHO_ACCOUNTS_BASE_URL || "https://accounts.zoho.com").replace(/\/+$/, "");
const clientId = process.env.ZOHO_MAIL_CLIENT_ID;
const clientSecret = process.env.ZOHO_MAIL_CLIENT_SECRET;
const repositoryRoot = path.resolve(__dirname, "..", "..");

function secureOutputPath(value) {
  const raw = String(value || "").trim();
  if (!raw || !path.isAbsolute(raw)) {
    throw new Error("ZOHO_REFRESH_TOKEN_OUTPUT must be an absolute path outside the LPC repository.");
  }
  const resolved = path.resolve(raw);
  if (resolved === repositoryRoot || resolved.startsWith(`${repositoryRoot}${path.sep}`)) {
    throw new Error("ZOHO_REFRESH_TOKEN_OUTPUT must remain outside the LPC repository.");
  }
  return resolved;
}

function writeRefreshToken(refreshToken, outputPath) {
  const target = secureOutputPath(outputPath);
  const parent = path.dirname(target);
  if (!fs.existsSync(parent) || !fs.statSync(parent).isDirectory()) {
    throw new Error("The ZOHO_REFRESH_TOKEN_OUTPUT parent directory must already exist.");
  }
  fs.writeFileSync(target, `ZOHO_MAIL_REFRESH_TOKEN=${String(refreshToken || "").trim()}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  fs.chmodSync(target, 0o600);
  return target;
}

function ask(question) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

function postToken(params) {
  const body = params.toString();
  return new Promise((resolve, reject) => {
    const req = https.request(
      `${accountsBaseUrl}/oauth/v2/token`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "Content-Length": Buffer.byteLength(body),
        },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => {
          data += chunk;
        });
        res.on("end", () => {
          let payload;
          try {
            payload = JSON.parse(data);
          } catch (_) {
            payload = { raw: data };
          }
          resolve({ statusCode: res.statusCode, payload });
        });
      }
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

async function main() {
  if (!clientId || !clientSecret) {
    console.error("Missing ZOHO_MAIL_CLIENT_ID or ZOHO_MAIL_CLIENT_SECRET in backend/.env.");
    process.exit(1);
  }

  let outputPath;
  try {
    outputPath = secureOutputPath(process.env.ZOHO_REFRESH_TOKEN_OUTPUT);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }

  console.log("This exchanges a temporary Zoho grant code for the LPC Mail refresh token.");
  console.log("Credentials and provider token payloads are never printed. The new file must not already exist.");
  const grantCode = await ask("Paste Zoho grant code: ");
  if (!grantCode) {
    console.error("No grant code entered.");
    process.exit(1);
  }

  const redirectUri = await ask("Redirect URI, if Zoho requires one. Otherwise press Enter: ");
  const params = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: clientId,
    client_secret: clientSecret,
    code: grantCode,
  });
  if (redirectUri) params.set("redirect_uri", redirectUri);

  const result = await postToken(params);
  if (!result.payload?.refresh_token) {
    const providerCode = String(result.payload?.error || "unknown_error").replace(/[^a-z0-9_.-]/gi, "_").slice(0, 80);
    console.error(`Zoho token exchange failed (HTTP ${Number(result.statusCode) || 0}, code ${providerCode}).`);
    process.exit(1);
  }

  const writtenPath = writeRefreshToken(result.payload.refresh_token, outputPath);
  console.log(`Refresh token written once to ${writtenPath} with mode 0600.`);
  console.log("Move it to the approved secret stores, then securely delete the file.");
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err?.message || "Zoho token exchange failed.");
    process.exit(1);
  });
}

module.exports = {
  secureOutputPath,
  writeRefreshToken,
};
