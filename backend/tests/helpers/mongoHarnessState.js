const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const STATE_VERSION = 1;
const PROJECT_ROOT = path.resolve(__dirname, "../..");
const PROJECT_KEY = crypto.createHash("sha256").update(PROJECT_ROOT).digest("hex").slice(0, 16);
const STATE_PATH = path.join(os.tmpdir(), `lpc-jest-mongo-${PROJECT_KEY}.json`);

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if (err?.code === "ESRCH") return false;
    if (err?.code === "EPERM") return true;
    throw err;
  }
}

function assertSafeStateFile() {
  const stat = fs.lstatSync(STATE_PATH);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`Refusing unsafe Jest Mongo state path: ${STATE_PATH}`);
  }
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
    throw new Error(`Jest Mongo state is not owned by the current user: ${STATE_PATH}`);
  }
  if ((stat.mode & 0o077) !== 0) {
    throw new Error(`Jest Mongo state must be owner-only (0600): ${STATE_PATH}`);
  }
  return stat;
}

function parseState({ requireReady = true } = {}) {
  assertSafeStateFile();
  let state;
  try {
    state = JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
  } catch (err) {
    throw new Error(`Jest Mongo state is unreadable or invalid: ${err.message}`);
  }

  if (
    state?.version !== STATE_VERSION ||
    state?.projectRoot !== PROJECT_ROOT ||
    !Number.isSafeInteger(state?.ownerPid) ||
    state.ownerPid <= 0
  ) {
    throw new Error("Jest Mongo state does not match this project or harness version.");
  }
  if (requireReady) {
    if (state.status !== "ready" || !/^mongodb:\/\/127\.0\.0\.1:\d+\/?$/.test(state.uri || "")) {
      throw new Error("The shared Jest Mongo process is not ready on a loopback-only address.");
    }
    if (!isProcessAlive(state.ownerPid)) {
      throw new Error("The shared Jest Mongo owner process is no longer running.");
    }
  }
  return state;
}

function claimStateFile() {
  if (fs.existsSync(STATE_PATH)) {
    const existing = parseState({ requireReady: false });
    if (isProcessAlive(existing.ownerPid)) {
      throw new Error(
        `Another Jest Mongo harness is active for this workspace (PID ${existing.ownerPid}).`
      );
    }
    fs.unlinkSync(STATE_PATH);
  }

  const descriptor = fs.openSync(STATE_PATH, "wx", 0o600);
  const starting = {
    version: STATE_VERSION,
    projectRoot: PROJECT_ROOT,
    ownerPid: process.pid,
    status: "starting",
  };
  fs.writeFileSync(descriptor, `${JSON.stringify(starting)}\n`, { encoding: "utf8" });
  fs.fsyncSync(descriptor);
  return descriptor;
}

function publishReadyState(descriptor, uri) {
  if (!/^mongodb:\/\/127\.0\.0\.1:\d+\/?$/.test(uri || "")) {
    throw new Error("Refusing to publish a non-loopback Jest Mongo URI.");
  }
  const ready = {
    version: STATE_VERSION,
    projectRoot: PROJECT_ROOT,
    ownerPid: process.pid,
    status: "ready",
    uri,
  };
  const readyPath = `${STATE_PATH}.${process.pid}.ready`;
  let readyDescriptor;
  try {
    readyDescriptor = fs.openSync(readyPath, "wx", 0o600);
    fs.writeFileSync(readyDescriptor, `${JSON.stringify(ready)}\n`, { encoding: "utf8" });
    fs.fsyncSync(readyDescriptor);
    fs.closeSync(readyDescriptor);
    readyDescriptor = undefined;
    fs.renameSync(readyPath, STATE_PATH);
    fs.closeSync(descriptor);
  } catch (err) {
    if (readyDescriptor !== undefined) {
      try {
        fs.closeSync(readyDescriptor);
      } catch (_closeErr) {
        // Preserve the publication error below.
      }
    }
    if (fs.existsSync(readyPath)) fs.unlinkSync(readyPath);
    throw err;
  }
}

function releaseStateFile(ownerPid = process.pid) {
  if (!fs.existsSync(STATE_PATH)) return;
  const state = parseState({ requireReady: false });
  if (state.ownerPid !== ownerPid) {
    throw new Error("Refusing to release a Jest Mongo state file owned by another process.");
  }
  fs.unlinkSync(STATE_PATH);
}

function readReadyState() {
  return parseState({ requireReady: true });
}

module.exports = {
  PROJECT_ROOT,
  STATE_PATH,
  claimStateFile,
  isProcessAlive,
  publishReadyState,
  readReadyState,
  releaseStateFile,
};
