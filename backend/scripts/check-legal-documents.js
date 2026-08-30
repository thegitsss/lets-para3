const fs = require("fs");
const path = require("path");
const {
  CURRENT_PRIVACY_VERSION,
  CURRENT_TERMS_VERSION,
} = require("../utils/legalDocuments");
const {
  assertLegalDocumentApproval,
  computeLegalDocumentHashes,
} = require("../utils/legalDocumentApproval");

const frontendDir = path.resolve(__dirname, "../../frontend");
const read = (name) => fs.readFileSync(path.join(frontendDir, name), "utf8");
const terms = read("terms.html");
const privacy = read("privacy.html");
const signup = read("signup.html");
const supportDrawer = read("assets/scripts/utils/support-drawer.js");

const failures = [];
const expectText = (content, pattern, message) => {
  if (!pattern.test(content)) failures.push(message);
};
const rejectText = (content, pattern, message) => {
  if (pattern.test(content)) failures.push(message);
};

const escapeRegExp = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const formatLegalVersionDate = (version) => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(version));
  if (!match) return null;
  const [, year, month, day] = match;
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  if (
    date.getUTCFullYear() !== Number(year)
    || date.getUTCMonth() !== Number(month) - 1
    || date.getUTCDate() !== Number(day)
  ) return null;
  return new Intl.DateTimeFormat("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(date);
};
const expectEffectiveDate = (content, version, documentName) => {
  const displayDate = formatLegalVersionDate(version);
  if (!displayDate) {
    failures.push(`${documentName} backend version is not a valid YYYY-MM-DD date.`);
    return;
  }
  expectText(
    content,
    new RegExp(`<p[^>]*class=["'][^"']*utility-hero__meta[^"']*["'][^>]*>\\s*Effective\\s+${escapeRegExp(displayDate)}\\s*</p>`, "i"),
    `${documentName} visible effective date does not match backend version ${version}.`
  );
};

expectEffectiveDate(terms, CURRENT_TERMS_VERSION, "Terms");
expectEffectiveDate(privacy, CURRENT_PRIVACY_VERSION, "Privacy");
expectText(terms, /id="section-24"[\s\S]*24\. Definitions/, "Terms are missing the consolidated general provisions and definitions.");
expectText(privacy, /AI-assisted support[\s\S]*OpenAI[\s\S]*store: false/i, "Privacy policy is missing the factual AI-support disclosure.");
expectText(supportDrawer, /AI support uses OpenAI[\s\S]*confidential or privileged matter content/, "The support composer is missing its AI data boundary.");
expectText(signup, /privacyAcknowledged[\s\S]*true/, "Signup does not submit a separate privacy acknowledgement.");
rejectText(privacy, /Indemnification|Waiver of Jury Trial|Choice of Law and Venue|LIMITATIONS OF LIABILITY/i, "Contract terms remain in the Privacy Policy.");


if (failures.length) {
  failures.forEach((failure) => console.error(`[legal] ${failure}`));
  process.exit(1);
}

const hashes = computeLegalDocumentHashes(frontendDir);
console.log(JSON.stringify({
  ok: true,
  versions: {
    terms: CURRENT_TERMS_VERSION,
    privacy: CURRENT_PRIVACY_VERSION,
  },
  sha256: hashes,
}, null, 2));

if (process.argv.includes("--require-approval")) {
  assertLegalDocumentApproval({ ...process.env, NODE_ENV: "production" }, { frontendDir });
  console.log("[legal] Counsel approval reference, versions, and document digests match.");
}
