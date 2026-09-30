const express = require('express');
const { requireRole } = require('../utils/authz');
const { parseChoiceQuery, readParalegalMatterChoices } = require('../services/paralegalMatterChoices');
const router = express.Router();
router.use(requireRole('paralegal'));
router.use((_req, res, next) => { res.set('Cache-Control', 'private, no-store'); next(); });
router.get('/', async (req, res, next) => {
  try {
    const ownerId = String(req.user.id);
    if (req.query.expectedOwnerId !== ownerId) return res.status(403).json({ code: 'ACCOUNT_CHANGED', error: 'The signed-in account changed. Reload your workspace.' });
    return res.json(await readParalegalMatterChoices(ownerId, parseChoiceQuery(req.query)));
  } catch (error) {
    if ([400, 409].includes(error.status)) return res.status(error.status).json({ code: error.publicCode, error: error.message });
    return next(error);
  }
});
module.exports = router;
