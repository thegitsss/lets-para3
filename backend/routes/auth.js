const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const axios = require('axios');
const User = require('../models/User');
const sendEmail = require('../utils/email');

router.post('/register', async (req, res) => {
  try {
    const { email, password, role, recaptchaToken } = req.body;

    // ✅ Verify reCAPTCHA
    const resp = await axios.post(
      `https://www.google.com/recaptcha/api/siteverify?secret=${process.env.RECAPTCHA_SECRET}&response=${recaptchaToken}`
    );

    if (!resp.data.success) {
      return res.status(400).json({ msg: 'reCAPTCHA validation failed' });
    }

    // ✅ Check for existing user
    const existingUser = await User.findOne({ email });
    if (existingUser) return res.status(400).json({ msg: 'User already exists' });

    // ✅ Create new user
    const salt = await bcrypt.genSalt(10);
    const hashed = await bcrypt.hash(password, salt);

    const newUser = new User({
      email,
      password: hashed,
      role,
      status: 'pending'
    });

    await newUser.save();

    // ✅ Send confirmation email
    await sendEmail(email, 'Registration received', `Thanks for registering. Your application is under review.`);

    res.json({ msg: 'Registered successfully. Await admin approval.' });

  } catch (err) {
    console.error(err);
    res.status(500).json({ msg: 'Server error' });
  }
});

module.exports = router;
