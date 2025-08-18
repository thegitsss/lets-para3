const express = require('express');
const router = express.Router();
const User = require('../models/User');
const Case = require('../models/Case');
const { verifyToken } = require('../utils/verifyToken');
const sendEmail = require('../utils/email');

// Admin middleware
function requireAdmin(req, res, next) {
  if (req.user.role !== 'admin') return res.status(403).json({ msg: 'Admins only' });
  next();
}

// ✅ Get all pending users
router.get('/pending-users', verifyToken, requireAdmin, async (req, res) => {
  try {
    const pending = await User.find({ status: 'pending' }).select('-password');
    res.json(pending);
  } catch (err) {
    res.status(500).json({ msg: 'Server error' });
  }
});

// ✅ Approve or reject a user
router.patch('/user/:id', verifyToken, requireAdmin, async (req, res) => {
  const { status } = req.body; // 'approved' or 'rejected'

  try {
    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ msg: 'User not found' });

    user.status = status;
    await user.save();
    user.audit.push({ adminId: req.user.id, action: status });
    await user.save();


    await sendEmail(
      user.email,
      `Your ParaConnect account has been ${status}`,
      `Hello ${user.fullName}, your account has been ${status}. You can now ${status === 'approved' ? 'log in and start using ParaConnect!' : 'contact support if needed.'}`
    );

    res.json({ msg: `User ${status}` });
  } catch (err) {
    console.error(err);
    res.status(500).json({ msg: 'Error updating user' });
  }
});

// ✅ Get all cases (admin)
router.get('/cases', verifyToken, requireAdmin, async (req, res) => {
  try {
    const cases = await Case.find().populate('createdBy assignedTo', 'email fullName');
    res.json({ cases });
  } catch (err) {
    res.status(500).json({ msg: 'Failed to get cases' });
  }
});

// ✅ Admin assigns paralegal
router.patch('/assign/:caseId', verifyToken, requireAdmin, async (req, res) => {
  const { paralegalId } = req.body;

  try {
    const c = await Case.findById(req.params.caseId);
    if (!c) return res.status(404).json({ msg: 'Case not found' });

    c.assignedTo = paralegalId;
    await c.save();

    res.json({ msg: 'Paralegal assigned' });
  } catch (err) {
    res.status(500).json({ msg: 'Failed to assign' });
  }
});

// Bulk approve/reject pending users
router.patch('/bulk-update', verifyToken, requireAdmin, async (req, res) => {
  const { status } = req.body;
  try {
    const updated = await User.updateMany(
      { status: 'pending' },
      {
        $set: { status },
        $push: {
          audit: { adminId: req.user.id, action: status }
        }
      }
    );

    res.json({ msg: `All pending users have been ${status}` });
  } catch (err) {
    res.status(500).json({ msg: 'Bulk update failed' });
  }
});

module.exports = router;
