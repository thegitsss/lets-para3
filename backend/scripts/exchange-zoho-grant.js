const https = require("https");
const path = require("path");
const readline = require("readline");

require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const DIRECTOR_KEY = "SKYLER";
const accountsBaseUrl = String(process.env.ZOHO_ACCOUNTS_BASE_URL || "https://accounts.zoho.com").replace(/\/+$/, "");
const clientId = process.env[`DIRECTOR_ZOHO_${DIRECTOR_KEY}_CLIENT_ID`];
const clientSecret = process.env[`DIRECTOR_ZOHO_${DIRECTOR_KEY}_CLIENT_SECRET`];

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
    console.error(`Missing DIRECTOR_ZOHO_${DIRECTOR_KEY}_CLIENT_ID or DIRECTOR_ZOHO_${DIRECTOR_KEY}_CLIENT_SECRET in backend/.env.`);
    process.exit(1);
  }

  console.log("This exchanges Skyler's temporary Zoho grant code for a refresh token.");
  console.log("It reads the client ID/secret from backend/.env and does not print them.");
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
    console.error("Zoho did not return a refresh token.");
    console.error(JSON.stringify(result.payload, null, 2));
    process.exit(1);
  }

  console.log("\nAdd this value to backend/.env and Render:");
  console.log(`DIRECTOR_ZOHO_${DIRECTOR_KEY}_REFRESH_TOKEN=${result.payload.refresh_token}`);
}

main().catch((err) => {
  console.error(err?.message || err);
  process.exit(1);
});
