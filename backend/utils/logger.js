const util = require("util");

const SECRET_PATTERNS = [
  { pattern: /sk-[a-z0-9_-]+/gi, replacement: "[REDACTED]" },
  { pattern: /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9_*.-]+\b/g, replacement: "[REDACTED]" },
  { pattern: /\bwhsec_[A-Za-z0-9]+\b/g, replacement: "[REDACTED]" },
  { pattern: /Bearer\s+[A-Za-z0-9._-]+/gi, replacement: "Bearer [REDACTED]" },
  {
    pattern: /(mongodb(?:\+srv)?:\/\/)[^\s/@:]+:[^\s/@]+@/gi,
    replacement: "$1[REDACTED]@",
  },
  { pattern: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, replacement: "[REDACTED]" },
  {
    pattern: /([?&](?:token|code|secret|key|signature)=)[^&#\s]+/gi,
    replacement: "$1[REDACTED]",
  },
  {
    pattern: /\b((?:token|code|secret|key|signature)=)[^&#\s]+/gi,
    replacement: "$1[REDACTED]",
  },
];

const SENSITIVE_KEY = /(?:password|secret|token|authorization|api[_-]?key|apikey|access[_-]?key|private[_-]?key)$/i;

function redactString(value) {
  let output = String(value);
  SECRET_PATTERNS.forEach(({ pattern, replacement }) => {
    output = output.replace(pattern, replacement);
  });
  return output;
}

function redactValue(value, seen = new WeakSet(), depth = 0) {
  if (typeof value === "string") return redactString(value);
  if (value instanceof Error) {
    return {
      name: value.name,
      message: redactString(value.message),
      stack: value.stack ? redactString(value.stack) : undefined,
    };
  }
  if (!value || typeof value !== "object") return value;
  if (depth >= 8) return "[MAX_DEPTH]";
  if (seen.has(value)) return "[CIRCULAR]";
  if (value instanceof Date) return value.toISOString();
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((item) => redactValue(item, seen, depth + 1));
    }
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        SENSITIVE_KEY.test(key) ? "[REDACTED]" : redactValue(item, seen, depth + 1),
      ])
    );
  } catch (_) {
    return redactString(util.inspect(value, { depth: 4, breakLength: 120 }));
  }
}

function shouldWriteLog(env = process.env) {
  if (env.NODE_ENV !== "test") return true;
  return String(env.LPC_TEST_LOGS || "").toLowerCase() === "true";
}

function createLogger(scope = "app") {
  const write = (level, args) => {
    if (!shouldWriteLog()) return;
    const method = level === "error" ? "error" : level === "warn" ? "warn" : "log";
    const safeArgs = args.map((arg) => redactValue(arg));
    if (process.env.NODE_ENV === "production") {
      const first = safeArgs[0];
      const message = typeof first === "string" ? first : "";
      const context = typeof first === "string" ? safeArgs.slice(1) : safeArgs;
      console[method](JSON.stringify({
        timestamp: new Date().toISOString(),
        level,
        scope: String(scope || "app"),
        message,
        ...(context.length ? { context } : {}),
      }));
      return;
    }
    console[method](`[lpc:${scope}]`, ...safeArgs);
  };

  return {
    info: (...args) => write("info", args),
    warn: (...args) => write("warn", args),
    error: (...args) => write("error", args),
    debug: (...args) => {
      if (process.env.NODE_ENV !== "production") write("debug", args);
    },
  };
}

function logPromiseFailure(logger, message, context = {}) {
  return (error) => {
    const payload = context && typeof context === "object"
      ? { ...context, error }
      : { error };
    logger?.error?.(message, payload);
  };
}

module.exports = {
  createLogger,
  logPromiseFailure,
  redactValue,
  shouldWriteLog,
};
