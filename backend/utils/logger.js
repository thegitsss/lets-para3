const util = require("util");

const SECRET_PATTERNS = [
  /sk-[a-z0-9_-]+/gi,
  /Bearer\s+[A-Za-z0-9._-]+/gi,
  /("?(?:api[_-]?key|authorization|token|secret|password)"?\s*:\s*)"[^"]+"/gi,
];

function redactString(value) {
  let output = String(value);
  SECRET_PATTERNS.forEach((pattern) => {
    output = output.replace(pattern, (_match, prefix) => {
      if (prefix) return `${prefix}"[REDACTED]"`;
      return "[REDACTED]";
    });
  });
  return output;
}

function redactValue(value) {
  if (typeof value === "string") return redactString(value);
  if (value instanceof Error) {
    return {
      name: value.name,
      message: redactString(value.message),
      stack: value.stack ? redactString(value.stack) : undefined,
    };
  }
  if (!value || typeof value !== "object") return value;
  try {
    return JSON.parse(redactString(JSON.stringify(value)));
  } catch (_) {
    return redactString(util.inspect(value, { depth: 4, breakLength: 120 }));
  }
}

function createLogger(scope = "app") {
  const write = (level, args) => {
    const method = level === "error" ? "error" : level === "warn" ? "warn" : "log";
    const safeArgs = args.map((arg) => redactValue(arg));
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

module.exports = {
  createLogger,
  redactValue,
};
