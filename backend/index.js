// Load environment variables
require('dotenv').config();

const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const path = require('path');

// Init express app
const app = express();

// Enable CORS (supports local Live Server + frontend)
app.use(cors({
  origin: '*', // Accepts all origins for development (adjust before production)
  methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

// Middleware
app.use(express.json());

// MongoDB Connection
mongoose.connect(process.env.MONGO_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true
})
.then(() => console.log('✅ MongoDB connected'))
.catch(err => console.error('❌ MongoDB error:', err));

// Static Frontend (adjust path as needed)
app.use(express.static(path.join(__dirname, '../frontend')));

// API Routes
app.use('/api/auth', require('./routes/auth'));
app.use('/api/admin', require('./routes/admin'));
app.use('/api/cases', require('./routes/cases'));
app.use('/api/payments', require('./routes/payments'));
app.use('/api/user', require('./routes/user'));
app.use('/api/messages', require('./routes/messages'));

// Health check route
app.get('/ping', (req, res) => res.send('pong'));

// Server startup
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`🚀 Server running at http://localhost:${PORT}`);
});
