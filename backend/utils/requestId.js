const crypto = require("crypto");

const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;

function requestIdMiddleware(req, res, next) {
  const supplied = String(req.get("X-Request-ID") || "").trim();
  req.requestId = REQUEST_ID_PATTERN.test(supplied) ? supplied : crypto.randomUUID();
  res.setHeader("X-Request-ID", req.requestId);
  next();
}

module.exports = {
  REQUEST_ID_PATTERN,
  requestIdMiddleware,
};
