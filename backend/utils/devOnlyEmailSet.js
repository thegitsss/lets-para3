function createDevOnlyEmailSet(emails = [], env = process.env) {
  const isProduction = String(env?.NODE_ENV || "").trim().toLowerCase() === "production";
  return new Set(isProduction ? [] : emails);
}

module.exports = { createDevOnlyEmailSet };
