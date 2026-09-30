const { createLogger } = require("./logger");

const logger = createLogger("operational-recovery");
const ERROR_NAMES = new Set([
  "Error", "AbortError", "TimeoutError", "ValidationError", "CastError",
  "MongoServerError", "MongoNetworkError", "MongoNetworkTimeoutError",
  "MongoWriteConcernError", "MongoServerSelectionError",
]);
const SYSTEM_CODES = new Set(["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EPIPE"]);

// Secondary cleanup/receipt failures must be observable without replacing the
// original operation's outcome or logging database content, tokens or uploads.
function reportOperationalFailure(operation) {
  if (typeof operation !== "string" || !/^[A-Za-z][A-Za-z0-9_.-]{1,119}$/.test(operation)) {
    throw new TypeError("Operational failure reporting requires a fixed operation name.");
  }
  return error => {
    try {
      logger.warn("Operational failure", {
        operation,
        errorType: ERROR_NAMES.has(error?.name) ? error.name : "UnknownError",
        ...(Number.isSafeInteger(error?.code) || SYSTEM_CODES.has(error?.code) ? { errorCode: error.code } : {}),
      });
      return { reported: true };
    } catch {
      // Logging is not authority to replace the primary payment/write error.
      return { reported: false };
    }
  };
}

module.exports = { reportOperationalFailure };
