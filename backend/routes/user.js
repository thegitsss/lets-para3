const express = require('express');
const router = express.Router();
const User = require('../models/User');
const { verifyToken } = require('../utils/verifyToken');
// Get own profile
router.get('/profile', verifyToken, async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select('-password');
    res.json(user);
  } catch {
    res.status(500).json({ msg: 'Failed to load profile' });
  }
});

// Update profile
router.post('/profile', verifyToken, async (req, res) => {
  const { bio, availability, resumeURL, certificateURL } = req.body;

  try {
    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ msg: 'User not found' });

    if (bio) user.bio = bio;
    if (typeof availability === 'boolean') user.availability = availability;
    if (resumeURL) user.resumeURL = resumeURL;
    if (certificateURL) user.certificateURL = certificateURL;

    await user.save();
    res.json({ msg: 'Profile updated' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ msg: 'Error updating profile' });
  }
});
module.exports = router;
