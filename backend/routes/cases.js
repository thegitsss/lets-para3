const express = require('express');
const router = express.Router();
const { verifyToken } = require('../utils/verifyToken');
const Case = require('../models/Case');
const sendEmail = require('../utils/email');
const User = require('../models/User');
const containsBad = require('../utils/badWords');

// Create new case (Attorney)
router.post('/', verifyToken, async (req, res) => {
  try {
    const { title, details } = req.body;
    const newCase = new Case({
      title,
      details,
      createdBy: req.user.id,
      status: 'open'
    });
    await newCase.save();
    res.json({ msg: 'Case submitted successfully.' });
  } catch (err) {
    res.status(500).json({ msg: 'Error creating case' });
  }
});

// Get all cases for current user (attorney or paralegal)
router.get('/my', verifyToken, async (req, res) => {
  try {
    const filter = req.user.role === 'attorney'
      ? { createdBy: req.user.id }
      : { assignedTo: req.user.id };
    const cases = await Case.find(filter).populate('assignedTo createdBy', 'email name');
    res.json(cases);
  } catch (err) {
    res.status(500).json({ msg: 'Could not fetch cases' });
  }
});

// Get single case by ID (for view or manage)
router.get('/:id', verifyToken, async (req, res) => {
  try {
    const c = await Case.findById(req.params.id)
      .populate('createdBy assignedTo disputes.raisedBy disputes.comments.by', 'email name');
    if (!c) return res.status(404).json({ msg: 'Not found' });
    res.json(c);
  } catch {
    res.status(500).json({ msg: 'Error fetching case' });
  }
});

// Raise dispute
router.post('/:id/dispute', verifyToken, async (req, res) => {
  const { message } = req.body;
  try {
    const c = await Case.findById(req.params.id);
    c.disputes.push({ message, raisedBy: req.user.id });
    await c.save();
    res.json({ msg: 'Dispute raised' });
  } catch {
    res.status(500).json({ msg: 'Dispute error' });
  }
});

// Add comment to dispute
router.post('/:caseId/dispute/:disputeId/comment', verifyToken, async (req, res) => {
  try {
    const c = await Case.findById(req.params.caseId);
    const d = c.disputes.id(req.params.disputeId);
    d.comments.push({ text: req.body.text, by: req.user.id });
    await c.save();
    res.json({ msg: 'Comment added' });
  } catch {
    res.status(500).json({ msg: 'Failed to comment' });
  }
});

// Resolve or reject dispute (admin only)
router.post('/:caseId/dispute/:disputeId', verifyToken, async (req, res) => {
  try {
    const c = await Case.findById(req.params.caseId).populate('disputes.raisedBy');
    const d = c.disputes.id(req.params.disputeId);
    d.status = req.body.action;
    await c.save();
    await sendEmail(
      d.raisedBy.email,
      `Your dispute was ${req.body.action}`,
      `Your dispute on case "${c.title}" was ${req.body.action}.`
    );
    res.json({ msg: 'Dispute updated' });
  } catch {
    res.status(500).json({ msg: 'Error resolving dispute' });
  }
});

module.exports = router;

// Paralegal applies to a case
router.post('/:id/apply', verifyToken, async (req, res) => {
  try {
    const c = await Case.findById(req.params.id);
    if (!c) return res.status(404).json({ msg: 'Case not found' });

    const already = c.applicants.find(app => app.paralegalId.toString() === req.user.id);
    if (already) return res.status(400).json({ msg: 'Already applied' });

    c.applicants.push({ paralegalId: req.user.id });
    await c.save();

    // Notify attorney
    const attorney = await User.findById(c.createdBy);
    const paralegal = await User.findById(req.user.id);
    await sendEmail(
      attorney.email,
      `New Application on "${c.title}"`,
      `${paralegal.name} has applied to your case "${c.title}".`
    );

    res.json({ msg: 'Application submitted' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ msg: 'Server error' });
  }
});

// Get all applicants for a case
router.get('/:id/applicants', verifyToken, async (req, res) => {
  try {
    const c = await Case.findById(req.params.id)
      .populate('applicants.paralegalId', 'name email resumeURL')
      .populate('acceptedParalegal', 'name email');

    if (!c || c.createdBy.toString() !== req.user.id)
      return res.status(403).json({ msg: 'Unauthorized or not found' });

    res.json(c.applicants);
  } catch (err) {
    res.status(500).json({ msg: 'Server error' });
  }
});

// Accept paralegal (auto-reject others)
router.post('/:id/accept/:paralegalId', verifyToken, async (req, res) => {
  try {
    const c = await Case.findById(req.params.id);
    if (!c || c.createdBy.toString() !== req.user.id)
      return res.status(403).json({ msg: 'Unauthorized or not found' });

    c.applicants = c.applicants.map(app => ({
      ...app.toObject(),
      status: app.paralegalId.toString() === req.params.paralegalId ? 'accepted' : 'rejected'
    }));

    c.acceptedParalegal = req.params.paralegalId;
    await c.save();

    const accepted = await User.findById(req.params.paralegalId);
    await sendEmail(
      accepted.email,
      `You've Been Accepted for Case: "${c.title}"`,
      `Congrats, ${accepted.name}! You’ve been selected to work on the case "${c.title}".`
    );

    res.json({ msg: 'Paralegal accepted and notified' });
  } catch (err) {
    res.status(500).json({ msg: 'Error accepting paralegal' });
  }
});
// Mark case as complete & release Stripe funds
router.post('/:id/complete', verifyToken, async (req, res) => {
  try {
    const c = await Case.findById(req.params.id).populate('acceptedParalegal');
    if (!c) return res.status(404).json({ msg: 'Case not found' });

    if (c.createdBy.toString() !== req.user.id)
      return res.status(403).json({ msg: 'Unauthorized' });

    if (!c.acceptedParalegal || !c.stripeSessionId)
      return res.status(400).json({ msg: 'Missing Stripe or assignee' });

    if (c.paymentReleased)
      return res.status(400).json({ msg: 'Payment already released' });

    // === SIMULATED PAYMENT RELEASE === //
    // TODO: use real payout via Stripe Connect or Transfer API
    c.paymentReleased = true;
    c.status = 'closed';
    await c.save();

    await sendEmail(
      c.acceptedParalegal.email,
      `Case Completed: "${c.title}"`,
      `Congrats! The attorney marked your case as complete and payment is being processed.`
    );

    res.json({ msg: 'Payment released and case closed.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ msg: 'Server error completing case' });
  }
});
// PATCH /api/cases/:id/zoom
router.patch('/:id/zoom', verifyToken, async (req, res) => {
  try {
    const c = await Case.findById(req.params.id);
    if (!c) return res.status(404).json({ msg: 'Case not found' });

    if (c.createdBy.toString() !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ msg: 'Not authorized' });
    }

    c.zoomLink = req.body.zoomLink;
    await c.save();
    res.json({ msg: 'Zoom link added', zoomLink: c.zoomLink });
  } catch (err) {
    res.status(500).json({ msg: 'Error updating Zoom link' });
  }
});
// PATCH /cases/:id/zoom-link
router.patch('/:id/zoom-link', verifyToken, async (req, res) => {
  const { zoomLink } = req.body;
  try {
    const updated = await Case.findByIdAndUpdate(req.params.id, { zoomLink }, { new: true });
    res.json(updated);
  } catch (err) {
    res.status(500).json({ msg: 'Failed to update Zoom link' });
  }
});



