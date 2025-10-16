// backend/index.js
require('dotenv').config();

const express = require('express');
const app = express();
const path = require('path');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');
const csrf = require('csurf');
const mongoose = require('mongoose');

const PROD = process.env.NODE_ENV === 'production';
const PORT = process.env.PORT || 5000;
const PUBLIC_DIR = path.join(__dirname, '../frontend');

// --- Security headers (lean) ---
app.use(helmet({
  hsts: PROD ? { maxAge: 31536000, includeSubDomains: true, preload: true } : false,
  referrerPolicy: { policy: 'no-referrer' },
}));
app.use(helmet.contentSecurityPolicy({
  useDefaults: true,
  directives: {
    "img-src": ["'self'", "data:", "https://*.stripe.com"],
    "connect-src": ["'self'", "https://api.stripe.com"],
    "script-src": ["'self'", "https://js.stripe.com"],       // remove 'unsafe-inline' in prod
    "style-src":  ["'self'", "'unsafe-inline'"],             // Stripe injects inline styles
    "frame-src":  ["'self'", "https://js.stripe.com"],       // Stripe Elements/3DS frames
    "font-src": ["'self'", "https://fonts.gstatic.com"],
  },
}));


// --- Parsers ---
app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());
app.use('/api/public', require('./routes/public'));

// --- Basic rate limits ---
app.use('/api/auth/login', rateLimit({ windowMs: 10 * 60 * 1000, max: 50 }));
app.use('/api/', rateLimit({ windowMs: 60 * 1000, max: 300 }));

// --- CSRF: dev-friendly cookie (no HTTPS required in dev) ---
const csrfProtection = csrf({
  cookie: {
    httpOnly: true,
    sameSite: PROD ? 'strict' : 'lax',
    secure: PROD, // false in dev so the cookie actually sets
  }
});

// Serve frontend
app.use(express.static(PUBLIC_DIR));

// Fetch CSRF token
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

// Fallback to index.html for plain “/”
app.get('/', (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

// 404/Errors
app.use((req, res) => res.status(404).send('Not found'));
app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).send('Server error');
});

// --- Mongo ---
const raw = process.env.MONGO_URI || '';
const MONGO = /<cluster>/.test(raw) || !raw ? 'mongodb://127.0.0.1:27017/lets-para' : raw;

mongoose.connect(MONGO)
  .then(() => console.log('✅ MongoDB connected'))
  .catch(err => console.error('❌ MongoDB error:', err));

// --- Start ---
app.listen(PORT, () => {
  console.log(`🚀 Server listening at http://localhost:${PORT}`);
});
