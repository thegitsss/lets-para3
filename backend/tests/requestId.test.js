const { requestIdMiddleware, REQUEST_ID_PATTERN } = require("../utils/requestId");

function runMiddleware(headerValue) {
  const req = { get: jest.fn(() => headerValue) };
  const res = { setHeader: jest.fn() };
  const next = jest.fn();
  requestIdMiddleware(req, res, next);
  return { req, res, next };
}

describe("request ID middleware", () => {
  test("preserves a safe upstream request ID", () => {
    const { req, res, next } = runMiddleware("edge-request_1234");
    expect(req.requestId).toBe("edge-request_1234");
    expect(res.setHeader).toHaveBeenCalledWith("X-Request-ID", "edge-request_1234");
    expect(next).toHaveBeenCalledTimes(1);
  });

  test.each(["short", "spaces are unsafe", "line\nbreak-value", "x".repeat(129)])(
    "replaces an invalid upstream identifier",
    (value) => {
      const { req, res } = runMiddleware(value);
      expect(req.requestId).not.toBe(value);
      expect(REQUEST_ID_PATTERN.test(req.requestId)).toBe(true);
      expect(res.setHeader).toHaveBeenCalledWith("X-Request-ID", req.requestId);
    }
  );
});
