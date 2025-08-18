const express = require('express');
const router = express.Router();
const Message = require('../models/Message');
const { verifyToken } = require('../utils/verifyToken'); // ✅ Fix

// 📤 Send a message
router.post('/:caseId/send', verifyToken, async (req, res) => {
  const { content } = req.body;
  if (!content) return res.status(400).json({ msg: 'Message is empty' });

  const m = new Message({
    caseId: req.params.caseId,
    sender: req.user.id,
    content
  });

  await m.save();
  res.json({ msg: 'Sent', message: m });
});

// 📥 Load messages for a case
router.get('/:caseId', verifyToken, async (req, res) => {
  const msgs = await Message.find({ caseId: req.params.caseId })
    .sort({ sentAt: 1 })
    .populate('sender', 'fullName role');

  res.json(msgs);
});

module.exports = router;
