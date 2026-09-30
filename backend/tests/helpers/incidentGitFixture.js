const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const sourceRoot = path.resolve(__dirname, "../../..");
let fixture;

// Exercise real Git operations without creating branches or commits in the
// developer checkout. The application snapshot need not itself contain .git.
function isolatedChildProcess(actual) {
  if (fixture) return fixture.childProcess;
  let repository;
  const worktrees = new Set();
  const environment = () => ({
    ...process.env,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
  });
  const git = (args, cwd) => actual.execFileSync("git", args, {
    cwd, env: environment(), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
  });
  function ensureRepository() {
    if (repository) return repository;
    repository = fs.mkdtempSync(path.join(os.tmpdir(), "lpc-incident-git-fixture-"));
    const notifications = "frontend/assets/scripts/utils/notifications.js";
    const preferences = "frontend/assets/scripts/profile-settings.js";
    fs.mkdirSync(path.dirname(path.join(repository, notifications)), { recursive: true });
    fs.copyFileSync(path.join(sourceRoot, notifications), path.join(repository, notifications));
    // The trusted workspace-sync recipe promotes the current repaired runner
    // source over an explicitly broken earlier preference implementation.
    // Do not accidentally depend on a dirty checkout differing from HEAD.
    fs.writeFileSync(path.join(repository, preferences),
      'function savePreferences() { throw new Error("Synthetic preference save failure"); }\n');
    git(["init", "--quiet"], repository);
    git(["add", "--", notifications, preferences], repository);
    git(["-c", "user.name=LPC Test Fixture", "-c", "user.email=fixture@lpc.invalid", "commit", "--quiet", "-m", "Synthetic incident source baseline"], repository);
    return repository;
  }
  const childProcess = {
    ...actual,
    execFileSync(command, args, options = {}) {
      if (command !== "git" || path.resolve(options.cwd || process.cwd()) !== sourceRoot) {
        return actual.execFileSync(command, args, options);
      }
      const cwd = ensureRepository();
      if (args[0] === "worktree" && args[1] === "add") {
        const target = path.resolve(args[4]);
        const allowed = path.join(os.tmpdir(), "lpc-incident-worktrees") + path.sep;
        if (!target.startsWith(allowed) || fs.existsSync(target)) throw new Error("Incident test worktree must be a new disposable path.");
        worktrees.add(target);
      }
      return actual.execFileSync(command, args, { ...options, cwd, env: environment() });
    },
  };
  fixture = {
    childProcess,
    close() {
      if (!repository) return;
      for (const target of worktrees) {
        git(["worktree", "remove", "--force", target], repository);
      }
      fs.rmSync(repository, { recursive: true, force: true });
      repository = undefined;
      worktrees.clear();
    },
  };
  return childProcess;
}

function cleanupIncidentGitFixture() {
  try { fixture?.close(); }
  finally { fixture = undefined; }
}

module.exports = { isolatedChildProcess, cleanupIncidentGitFixture };
