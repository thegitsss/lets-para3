process.env.NODE_ENV = "test";
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-jwt-secret-at-least-32-bytes-long";
process.env.DATA_ENCRYPTION_KEY =
  process.env.DATA_ENCRYPTION_KEY ||
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
process.env.APP_BASE_URL = process.env.APP_BASE_URL || "http://localhost:5050";
process.env.EMAIL_DISABLE = "true";
process.env.ENABLE_CSRF = "false";
