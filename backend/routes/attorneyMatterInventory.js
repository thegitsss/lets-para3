const express = require('express');
const mongoose = require('mongoose');
const { createHash } = require('node:crypto');
const { requireRole } = require('../utils/authz');
const Case = require('../models/Case');
const CaseDraft = require('../models/CaseDraft');
const { presentMatterDraft } = require('../services/matterDraftPresentation');
const { parseInventoryQuery, readInventory } = require('../services/attorneyMatterInventory');
const { parseHomeQuery, readHomeInventory } = require('../services/attorneyHomeInventory');
const { parseChoiceQuery, readMatterChoices } = require('../services/attorneyMatterChoices');

module.exports = ({ presentCases, caseProjection }) => {
  const router = express.Router();
  router.use(requireRole('attorney'));
  router.use((_req, res, next) => { res.set('Cache-Control', 'private, no-store'); next(); });
  router.get('/choices', async (req, res, next) => {
    try {
      const ownerId = String(req.user.id);
      if (req.query.expectedOwnerId !== ownerId) return res.status(403).json({ code: 'ACCOUNT_CHANGED', error: 'The signed-in account changed. Reload your workspace.' });
      return res.json(await readMatterChoices(ownerId, parseChoiceQuery(req.query)));
    } catch (error) {
      if ([400, 409].includes(error.status)) return res.status(error.status).json({ code: error.publicCode, error: error.message });
      return next(error);
    }
  });
  router.get('/home', async (req, res, next) => {
    try {
      const ownerId = String(req.user.id);
      if (req.query.expectedOwnerId !== ownerId) return res.status(403).json({ code: 'ACCOUNT_CHANGED', error: 'The signed-in account changed. Reload your workspace.' });
      return res.json(await readHomeInventory(ownerId, parseHomeQuery(req.query)));
    } catch (error) {
      if ([400, 409].includes(error.status)) return res.status(error.status).json({ code: error.publicCode, error: error.message });
      return next(error);
    }
  });
  router.get('/', async (req, res, next) => {
    try {
      const ownerId = String(req.user.id);
      if (req.query.expectedOwnerId !== ownerId) return res.status(403).json({ code: 'ACCOUNT_CHANGED', error: 'The signed-in account changed. Reload your workspace.' });
      const filters = parseInventoryQuery(req.query), inventory = await readInventory(ownerId, filters);
      const variants = [new mongoose.Types.ObjectId(ownerId), ownerId, ownerId.toUpperCase()];
      const ids = type => inventory.rows.filter(row => row.__inventorySource === type).map(row => row._id);
      const [cases, drafts] = await Promise.all([
        Case.collection.find({ _id: { $in: ids('case') }, $or: [{ attorney: { $in: variants } }, { attorneyId: { $in: variants } }] }, { projection: caseProjection }).toArray(),
        CaseDraft.collection.find({ _id: { $in: ids('draft') }, owner: { $in: variants } }).toArray(),
      ]);
      const raw = new Map([...cases.map(doc => [`case:${doc._id}`, doc]), ...drafts.map(doc => [`draft:${doc._id}`, doc])]);
      const stamp = value => value ? new Date(value).getTime() : null;
      if (inventory.rows.some(row => !raw.has(`${row.__inventorySource}:${row._id}`) || stamp(raw.get(`${row.__inventorySource}:${row._id}`).updatedAt) !== stamp(row.updatedAt))) {
        return res.status(409).json({ code: 'MATTER_LIST_CHANGED', error: 'Your Matters changed while this page was loading. Refresh the list.' });
      }
      await Case.populate(cases, [
        { path: 'paralegalId', select: 'firstName lastName email role avatarURL' },
        { path: 'attorneyId', select: 'firstName lastName email role avatarURL' },
        { path: 'paralegal', select: 'firstName lastName email role avatarURL' },
        { path: 'attorney', select: 'firstName lastName email role avatarURL' },
        { path: 'internalNotes.updatedBy', select: 'firstName lastName email role avatarURL' },
      ]);
      const presented = new Map((await presentCases(cases, req)).map(doc => [`case:${doc.id}`, doc]));
      for (const doc of drafts) presented.set(`draft:${doc._id}`, presentMatterDraft(doc));
      const items = inventory.rows.map(row => ({ ...presented.get(`${row.__inventorySource}:${row._id}`), lastActivityAt: row.lastActivityAt || null, recordType: row.__inventorySource === 'draft' ? 'draft' : 'matter', archiveBucket: row.__inventorySource === 'case' && row.__inventoryArchiveSource === true }));
      await inventory.verify();
      const { rows: _rows, verify: _verify, ...result } = inventory;
      const revision = createHash('sha256').update(JSON.stringify({ ...result, items })).digest('hex');
      return res.json({ ...result, revision, items });
    } catch (error) {
      if (error.status === 400) return res.status(400).json({ error: 'Invalid Matter list request.' });
      if (error.status === 409) return res.status(409).json({ code: 'MATTER_LIST_CHANGED', error: 'Your Matters changed while this page was loading. Refresh the list.' });
      return next(error);
    }
  });
  return router;
};
