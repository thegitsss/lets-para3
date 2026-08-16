const {
  RELEASE_COMMIT_HEADER,
  assertRenderReleaseIdentity,
  releaseCommit,
  releaseIdentityMiddleware,
} = require("../utils/releaseIdentity");

const COMMIT = "a".repeat(40);

function responseRecorder() {
  const headers = new Map();
  return {
    headers,
    setHeader(name, value) {
      headers.set(String(name).toLowerCase(), String(value));
    },
  };
}

describe("release identity", () => {
  test("normalizes a full Render Git commit and rejects ambiguous identifiers", () => {
    expect(releaseCommit({ RENDER_GIT_COMMIT: COMMIT.toUpperCase() })).toBe(COMMIT);
    expect(releaseCommit({ RENDER_GIT_COMMIT: COMMIT.slice(0, 12) })).toBe("");
    expect(releaseCommit({ RENDER_GIT_COMMIT: "not-a-commit" })).toBe("");
  });

  test("fails closed when a production Render process lacks exact commit identity", () => {
    expect(() =>
      assertRenderReleaseIdentity({ NODE_ENV: "production", RENDER: "true" }, "web service")
    ).toThrow(/full RENDER_GIT_COMMIT/i);
    expect(
      assertRenderReleaseIdentity(
        { NODE_ENV: "production", RENDER: "true", RENDER_GIT_COMMIT: COMMIT },
        "web service"
      )
    ).toBe(COMMIT);
  });

  test("adds an auditable release header without inventing local identity", () => {
    const productionResponse = responseRecorder();
    const next = jest.fn();
    releaseIdentityMiddleware({ RENDER_GIT_COMMIT: COMMIT })({}, productionResponse, next);
    expect(productionResponse.headers.get(RELEASE_COMMIT_HEADER.toLowerCase())).toBe(COMMIT);
    expect(next).toHaveBeenCalledTimes(1);

    const localResponse = responseRecorder();
    releaseIdentityMiddleware({})({}, localResponse, next);
    expect(localResponse.headers.has(RELEASE_COMMIT_HEADER.toLowerCase())).toBe(false);
  });
});
