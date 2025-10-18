console.log("🎯 index.js IS RUNNING from backend/");

// 0) Env
require('dotenv').config();

// 1) Core + Libs
const express = require('express');
const path = require('path');
const mongoose = require('mongoose');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');
const csrf = require('csurf');

const app = express();

// 2) Config
const PROD = process.env.NODE_ENV === 'production';
const PORT = process.env.PORT || 5050;
const FRONTEND_DIR = path.join(__dirname, '../frontend');

// 3) Middleware
app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());
app.use(
  helmet({
    hsts: PROD
      ? { maxAge: 31536000, includeSubDomains: true, preload: true }
      : false,
    referrerPolicy: { policy: 'no-referrer' },
  })
);
app.use(
  helmet.contentSecurityPolicy({
    useDefaults: true,
    directives: {
      "img-src": ["'self'", "data:", "https://*.stripe.com"],
      "connect-src": ["'self'", "https://api.stripe.com"],
      "script-src": ["'self'", "https://js.stripe.com"],
      "style-src": ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      "frame-src": ["'self'", "https://js.stripe.com"],
      "font-src": ["'self'", "https://fonts.gstatic.com", "data:"],
    },
  })
);

// 4) CSRF Setup
const csrfProtection = csrf({
  cookie: {
    httpOnly: true,
    sameSite: PROD ? 'strict' : 'lax',
    secure: PROD,
  },
});

// 5) Rate Limiting
app.use('/api/auth/login', rateLimit({ windowMs: 10 * 60 * 1000, max: 50 }));
app.use('/api/', rateLimit({ windowMs: 60 * 1000, max: 300 }));

// 6) API Routes
app.use('/api/waitlist', require('./routes/waitlist'));
app.use('/api/auth', require('./routes/auth'));
app.use('/api/admin', require('./routes/admin'));
app.use('/api/cases', require('./routes/cases'));
app.use('/api/messages', require('./routes/messages'));
app.use('/api/uploads', require('./routes/uploads'));
app.use('/api/payments', require('./routes/payments'));
app.use('/api/users', require('./routes/users'));
app.use('/api/disputes', require('./routes/disputes'));
app.post(
  '/api/payments/webhook',
  express.raw({ type: 'application/json' }),
  require('./routes/paymentsWebhook')
);

// 7) CSRF token route
app.get('/api/csrf', csrfProtection, (req, res) => {
  res.json({ csrfToken: req.csrfToken() });
});

// 8) Serve frontend
app.use(express.static(FRONTEND_DIR));

// ✅ Express v5 compatible catch-all route
app.get(/.*/, (req, res) => {
  res.sendFile(path.join(FRONTEND_DIR, 'index.html'));
});

// 9) Error + 404 Handlers
app.use((req, res) => res.status(404).send('Not found'));
app.use((err, _req, res, _next) => {
  console.error('❌ Uncaught error:', err);
  res.status(500).send('Server error');
});

// 10) MongoDB Connection
const raw = process.env.MONGO_URI || '';
const MONGO =
  /<cluster>/.test(raw) || !raw
    ? 'mongodb://127.0.0.1:27017/lets-para'
    : raw;

mongoose
  .connect(MONGO)
  .then(() => console.log('✅ MongoDB connected'))
  .catch((err) => console.error('❌ MongoDB error:', err));

// 11) Start Server
app.listen(PORT, () => {
  console.log(`🚀 Server is live at http://localhost:${PORT}`);
});
