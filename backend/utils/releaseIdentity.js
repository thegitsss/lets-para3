"use strict";

const RELEASE_COMMIT_HEADER = "X-LPC-Release-Commit";

function releaseCommit(env = process.env) {
  const value = String(env.RENDER_GIT_COMMIT || "").trim().toLowerCase();
  return /^[a-f0-9]{40}$/.test(value) ? value : "";
}

function isRenderRuntime(env = process.env) {
  return String(env.RENDER || "").trim().toLowerCase() === "true";
}

function assertRenderReleaseIdentity(env = process.env, scope = "production service") {
  if (env.NODE_ENV !== "production" || !isRenderRuntime(env)) return releaseCommit(env);
  const commit = releaseCommit(env);
  if (!commit) {
    throw new Error(
      `[config] ${scope} requires Render's full RENDER_GIT_COMMIT so deployed code can be bound to the approved release.`
    );
  }
  return commit;
}

function releaseIdentityMiddleware(env = process.env) {
  const commit = releaseCommit(env);
  return (_req, res, next) => {
    if (commit) res.setHeader(RELEASE_COMMIT_HEADER, commit);
    next();
  };
}

module.exports = {
  RELEASE_COMMIT_HEADER,
  assertRenderReleaseIdentity,
  isRenderRuntime,
  releaseCommit,
  releaseIdentityMiddleware,
};
