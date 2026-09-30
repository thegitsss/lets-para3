"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const { assertStorageStatePath, writeStorageStateOwnerOnly } = require("./auth-state");

function sessionNeedsSignIn(state, minimumRemainingMs, now = Date.now()) {
  const token = state.cookies?.find(cookie => cookie.name === "token");
  if (!token || !Number.isFinite(token.expires) || token.expires <= 0) {
    throw new Error("The saved support session needs an explicit expiring token cookie.");
  }
  return token.expires * 1000 <= now + minimumRemainingMs;
}

async function ensureSavedSupportSession({ browser, baseURL, storageState, minimumRemainingMs }) {
  // An explicit per-test state belongs to that test, including closure and
  // session-loss scenarios. Never repair a running test's authentication.
  if (typeof storageState !== "string") return false;
  const role = { "support-paralegal.json": "paralegal", "support-attorney.json": "attorney" }[path.basename(storageState)];
  if (!role) return false;
  const file = assertStorageStatePath(storageState);
  const origin = new URL(baseURL);
  if (origin.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(origin.hostname)) {
    throw new Error("Saved support sessions may be renewed only on the local synthetic server.");
  }
  const saved = JSON.parse(await fs.readFile(file, "utf8"));
  if (!sessionNeedsSignIn(saved, minimumRemainingMs)) return false;
  const storedUser = saved.origins?.find(item => item.origin === origin.origin)?.localStorage?.find(item => item.name === "lpc_user");
  const user = storedUser ? JSON.parse(storedUser.value) : null;
  const ownerId = String(user?.id || user?._id || "");
  if (!ownerId || user.role !== role || user.status !== "approved") {
    throw new Error("The saved support session has no verified matching owner.");
  }
  const prefix = `CONTROL_ROOM_E2E_SUPPORT_${role.toUpperCase()}`;
  const email = String(process.env[`${prefix}_EMAIL`] || `support.cr.e2e.${role}@lets-paraconnect.dev`).trim().toLowerCase();
  const password = String(process.env[`${prefix}_PASSWORD`] || "ControlRoomSupport123!").trim();
  const context = await browser.newContext({ baseURL, storageState: saved });
  try {
    const csrfResponse = await context.request.get("/api/csrf");
    const csrf = await csrfResponse.json();
    if (!csrfResponse.ok() || !csrf.csrfToken) throw new Error("Synthetic session sign-in could not obtain CSRF protection.");
    const login = await context.request.post("/api/auth/login", {
      headers: { "X-CSRF-Token": csrf.csrfToken }, data: { email, password },
    });
    if (!login.ok()) throw new Error(`Synthetic session sign-in failed (${login.status()}).`);
    const response = await context.request.get("/api/auth/me");
    const current = (await response.json()).user;
    if (!response.ok() || String(current?.id || current?._id || "") !== ownerId || current?.role !== role || current?.status !== "approved") {
      throw new Error("Synthetic session sign-in did not confirm the same approved owner.");
    }
    if (sessionNeedsSignIn(await context.storageState(), minimumRemainingMs)) {
      throw new Error("Synthetic sign-in did not provide enough time for the next test.");
    }
    await writeStorageStateOwnerOnly(context, file);
    return true;
  } finally {
    await context.close();
  }
}

module.exports = { ensureSavedSupportSession, sessionNeedsSignIn };
