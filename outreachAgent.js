#!/usr/bin/env node

const path = require("path");
const readline = require("readline/promises");
const { stdin: input, stdout: output } = require("process");

function loadPlaywright() {
  try {
    return require("playwright");
  } catch (error) {
    return require(path.join(__dirname, "backend", "node_modules", "playwright"));
  }
}

const { chromium } = loadPlaywright();

const SEARCH_URL = "https://www.linkedin.com/search/results/people/?keywords=attorney";
const LINK_PLACEHOLDER = process.env.OUTREACH_LINK || "[INSERT LINK]";
const MAX_MESSAGES = 30;
const MIN_ACTION_DELAY_MS = 800;
const MAX_ACTION_DELAY_MS = 2200;
const MIN_MESSAGE_DELAY_MS = 20_000;
const MAX_MESSAGE_DELAY_MS = 45_000;
const MAX_SCROLL_ROUNDS = 12;
const MAX_PROFILE_COLLECT = 160;

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

async function delay(min, max = min) {
  const duration = randomInt(min, max);
  return new Promise((resolve) => setTimeout(resolve, duration));
}

async function safeClick(locator, label, options = {}) {
  try {
    await locator.waitFor({ state: "visible", timeout: options.timeout ?? 4000 });
    await delay(300, 900);
    await locator.click({ timeout: options.timeout ?? 4000 });
    console.log(`[click] ${label}`);
    return true;
  } catch (error) {
    console.log(`[click:skip] ${label} :: ${error.message}`);
    return false;
  }
}

async function safeFill(locator, value, label, options = {}) {
  try {
    await locator.waitFor({ state: "visible", timeout: options.timeout ?? 4000 });
    await delay(250, 700);
    await locator.click({ timeout: options.timeout ?? 4000 });
    await locator.fill("");
    await delay(150, 450);
    await locator.fill(value, { timeout: options.timeout ?? 4000 });
    console.log(`[fill] ${label}`);
    return true;
  } catch (error) {
    console.log(`[fill:skip] ${label} :: ${error.message}`);
    return false;
  }
}

function normalizeProfileUrl(url = "") {
  try {
    const next = new URL(url);
    next.hash = "";
    next.search = "";
    const pathname = next.pathname.replace(/\/$/, "");
    if (!pathname.startsWith("/in/")) return "";
    next.pathname = pathname;
    return next.toString();
  } catch {
    return "";
  }
}

function extractFirstName(text = "") {
  const cleaned = String(text || "")
    .replace(/\(.*?\)/g, " ")
    .replace(/\[.*?\]/g, " ")
    .replace(/[|,]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!cleaned) return "there";

  const [firstToken] = cleaned.split(" ");
  const firstName = firstToken.replace(/[^a-zA-Z'-]/g, "").trim();
  return firstName || "there";
}

function buildMessage(firstName) {
  return `Hi ${firstName} — I’m the founder of Let’s-ParaConnect, a platform built for attorneys who want vetted, project-based paralegal support on a flat-fee basis. No subscriptions and no staffing agency model — just direct attorney-to-paralegal collaboration. Here’s the link if you’d like to take a look: ${LINK_PLACEHOLDER}`;
}

async function promptForLogin() {
  const rl = readline.createInterface({ input, output });
  try {
    await rl.question("Log into LinkedIn in the opened browser, then press Enter to continue...");
  } finally {
    rl.close();
  }
}

async function collectProfileUrls(page) {
  const urls = new Set();

  for (let round = 0; round < MAX_SCROLL_ROUNDS; round += 1) {
    const hrefs = await page.evaluate(() => {
      return Array.from(document.querySelectorAll("a[href*='/in/']"))
        .map((anchor) => anchor.href)
        .filter(Boolean);
    });

    for (const href of hrefs) {
      const normalized = normalizeProfileUrl(href);
      if (normalized) {
        urls.add(normalized);
      }
    }

    console.log(`[search] scroll ${round + 1}/${MAX_SCROLL_ROUNDS} :: collected ${urls.size} unique profile URLs`);

    if (urls.size >= MAX_PROFILE_COLLECT) break;

    await page.mouse.wheel(0, randomInt(1800, 3200));
    await delay(1200, 2400);
  }

  return [...urls];
}

async function dismissComposerIfPresent(page) {
  const discardButton = page.getByRole("button", { name: /discard|close conversation|close/i }).first();
  if (await discardButton.count()) {
    await safeClick(discardButton, "dismiss composer", { timeout: 1500 });
  }

  const closeButton = page.getByRole("button", { name: /^close$/i }).first();
  if (await closeButton.count()) {
    await safeClick(closeButton, "close modal", { timeout: 1500 });
  }
}

async function openMessageComposer(page) {
  const messageButton = page
    .getByRole("button", { name: /^message$/i })
    .filter({ hasNot: page.getByRole("button", { name: /pending|connect|follow/i }) })
    .first();

  if (!(await messageButton.count())) {
    return false;
  }

  return safeClick(messageButton, "message button");
}

async function findComposerTextbox(page) {
  const dialog = page.getByRole("dialog").last();
  if (await dialog.count()) {
    const textbox = dialog.getByRole("textbox").last();
    if (await textbox.count()) return textbox;
  }

  const fallbackTextbox = page.getByRole("textbox").last();
  if (await fallbackTextbox.count()) return fallbackTextbox;
  return null;
}

async function findSendButton(page) {
  const dialog = page.getByRole("dialog").last();
  if (await dialog.count()) {
    const send = dialog.getByRole("button", { name: /^send$/i }).first();
    if (await send.count()) return send;
  }

  const fallbackSend = page.getByRole("button", { name: /^send$/i }).first();
  if (await fallbackSend.count()) return fallbackSend;
  return null;
}

async function processProfile(page, profileUrl, sentProfiles) {
  const result = {
    name: "",
    profileUrl,
    status: "skipped",
  };

  try {
    if (sentProfiles.has(profileUrl)) {
      result.status = "skipped";
      console.log(`[profile] duplicate in run :: ${profileUrl}`);
      return result;
    }

    await page.goto(profileUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await delay(MIN_ACTION_DELAY_MS, MAX_ACTION_DELAY_MS);

    const headingLocator = page.getByRole("heading", { level: 1 }).first();
    const headingText = (await headingLocator.textContent({ timeout: 5000 }).catch(() => "")) || "";
    const firstName = extractFirstName(headingText);
    result.name = firstName;

    console.log(`[profile] visiting ${firstName || "Unknown"} :: ${profileUrl}`);

    const opened = await openMessageComposer(page);
    if (!opened) {
      result.status = "skipped";
      console.log(`[profile] no message button :: ${profileUrl}`);
      return result;
    }

    await delay(MIN_ACTION_DELAY_MS, MAX_ACTION_DELAY_MS);

    const textbox = await findComposerTextbox(page);
    if (!textbox) {
      result.status = "failed";
      console.log(`[profile] message box missing :: ${profileUrl}`);
      await dismissComposerIfPresent(page);
      return result;
    }

    const message = buildMessage(firstName);
    const filled = await safeFill(textbox, message, `message body for ${firstName}`);
    if (!filled) {
      result.status = "failed";
      await dismissComposerIfPresent(page);
      return result;
    }

    await delay(MIN_ACTION_DELAY_MS, MAX_ACTION_DELAY_MS);

    const sendButton = await findSendButton(page);
    if (!sendButton) {
      result.status = "failed";
      console.log(`[profile] send button missing :: ${profileUrl}`);
      await dismissComposerIfPresent(page);
      return result;
    }

    const sent = await safeClick(sendButton, `send message to ${firstName}`);
    if (!sent) {
      result.status = "failed";
      await dismissComposerIfPresent(page);
      return result;
    }

    sentProfiles.add(profileUrl);
    result.status = "sent";
    console.log(`[result] name=${firstName} url=${profileUrl} status=sent`);
    return result;
  } catch (error) {
    result.status = "failed";
    console.log(`[result] name=${result.name || "Unknown"} url=${profileUrl} status=failed error=${error.message}`);
    await dismissComposerIfPresent(page).catch(() => {});
    return result;
  }
}

async function main() {
  const browser = await chromium.launch({
    headless: false,
    slowMo: 150,
  });

  const context = await browser.newContext({
    viewport: { width: 1440, height: 960 },
  });

  const page = await context.newPage();
  const sentProfiles = new Set();
  let sentCount = 0;

  try {
    console.log("[startup] opening LinkedIn for manual login");
    await page.goto("https://www.linkedin.com/login", { waitUntil: "domcontentloaded", timeout: 60_000 });
    await promptForLogin();

    console.log("[search] navigating to people search");
    await page.goto(SEARCH_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await delay(2500, 4500);

    const profileUrls = await collectProfileUrls(page);
    console.log(`[search] total unique profiles collected: ${profileUrls.length}`);

    for (const profileUrl of profileUrls) {
      if (sentCount >= MAX_MESSAGES) {
        console.log(`[done] reached max messages: ${MAX_MESSAGES}`);
        break;
      }

      const result = await processProfile(page, profileUrl, sentProfiles);
      console.log(`[log] name=${result.name || "Unknown"} profile=${result.profileUrl} status=${result.status}`);

      if (result.status === "sent") {
        sentCount += 1;
        const waitMs = randomInt(MIN_MESSAGE_DELAY_MS, MAX_MESSAGE_DELAY_MS);
        console.log(`[delay] waiting ${Math.round(waitMs / 1000)}s before next message`);
        await delay(waitMs);
      } else {
        await delay(2500, 6000);
      }
    }

    console.log(`[complete] messages sent: ${sentCount}`);
  } catch (error) {
    console.error(`[fatal] ${error.message}`);
  }
}

main().catch((error) => {
  console.error(`[fatal] ${error.message}`);
});
