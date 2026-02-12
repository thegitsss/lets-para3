process.env.NODE_ENV = "test";
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-jwt-secret";
process.env.APP_BASE_URL = process.env.APP_BASE_URL || "http://localhost:5050";
process.env.EMAIL_DISABLE = "true";
process.env.ENABLE_CSRF = "false";
