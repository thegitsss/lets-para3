// backend/index.js  (CommonJS, single app)

// 0) Env
require('dotenv').config();

// 1) Core + libs
const express = require('express');
const path = require('path');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');
const csrf = require('csurf');
const mongoose = require('mongoose');

// 2) Routers
const waitlistRouter = require('./routes/waitlist'); // <-- our new route

// 3) Config
const PROD = process.env.NODE_ENV === 'production';
const PORT = process.env.PORT || 5000;
const PUBLIC_DIR = path.join(__dirname, '../frontend');

// 4) App (create ONCE)
const app = express();

// 5) Parsers early
app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());

// 6) Security headers (kept from your file)
app.use(helmet({
  hsts: PROD ? { maxAge: 31536000, includeSubDomains: true, preload: true } : false,
  referrerPolicy: { policy: 'no-referrer' },
}));
app.use(helmet.contentSecurityPolicy({
  useDefaults: true,
  directives: {
    "img-src": ["'self'", "data:", "https://*.stripe.com"],
    "connect-src": ["'self'", "https://api.stripe.com"], // add more origins here if needed
    "script-src": ["'self'", "https://js.stripe.com"],
    "style-src":  ["'self'", "'unsafe-inline'"],
    "frame-src":  ["'self'", "https://js.stripe.com"],
    "font-src": ["'self'", "https://fonts.gstatic.com"],
  },
}));

// 7) Mount /api/waitlist BEFORE CSRF (so curl works without token)
app.use('/api/waitlist', waitlistRouter);

// 8) Other routes/middleware (your existing order)
app.use('/api/public', require('./routes/public'));

// Rate limits
app.use('/api/auth/login', rateLimit({ windowMs: 10 * 60 * 1000, max: 50 }));
app.use('/api/', rateLimit({ windowMs: 60 * 1000, max: 300 }));

// CSRF cookie config
const csrfProtection = csrf({
  cookie: {
    httpOnly: true,
    sameSite: PROD ? 'strict' : 'lax',
    secure: PROD,
  }
});

// Static frontend
app.use(express.static(PUBLIC_DIR));

// CSRF token endpoint
app.get('/api/csrf', csrfProtection, (req, res) => {
  res.json({ csrfToken: req.csrfToken() });
});

// API routes
app.use('/api/auth', require('./routes/auth'));
app.use('/api/admin', require('./routes/admin'));
app.use('/api/cases', require('./routes/cases'));
app.use('/api/messages', require('./routes/messages'));
app.use('/api/uploads', require('./routes/uploads'));
app.use('/api/payments', require('./routes/payments'));
app.use('/api/users', require('./routes/users'));
app.use('/api/disputes', require('./routes/disputes'));
app.post('/api/payments/webhook',
  express.raw({ type: 'application/json' }),
  require('./routes/paymentsWebhook')
);

// Serve Coming Soon at the homepage
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '../frontend/coming-soon.html'));
});

// 404 + error handler
app.use((req, res) => res.status(404).send('Not found'));
app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).send('Server error');
});

// Mongo
const raw = process.env.MONGO_URI || '';
const MONGO = /<cluster>/.test(raw) || !raw ? 'mongodb://127.0.0.1:27017/lets-para' : raw;
mongoose.connect(MONGO)
  .then(() => console.log('✅ MongoDB connected'))
  .catch(err => console.error('❌ MongoDB error:', err));

// Start
app.listen(PORT, () => {
  console.log(`🚀 Server listening at http://localhost:${PORT}`);
});
