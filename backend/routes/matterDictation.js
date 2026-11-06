const express = require('express');
const multer = require('multer');
const {rateLimit} = require('express-rate-limit');
const {csrfProtection} = require('../utils/csrf');
const {MAX_AUDIO_BYTES, transcribeMatterNotes, createMatterDictationSession} = require('../services/matterDictation');
const router = express.Router();
const receive = multer({storage:multer.memoryStorage(), limits:{fileSize:MAX_AUDIO_BYTES, files:1, fields:0, parts:1}}).single('audio');
const limit = rateLimit({windowMs:60000, limit:5, standardHeaders:true, legacyHeaders:false, keyGenerator:req=>String(req.user.id), message:{error:'Please wait before dictating another note.'}});

// Mounted inside caseDrafts, after its authenticated, approved-role checks.
router.post('/live', csrfProtection, express.json({limit:'70kb'}), (req,res,next) => {
  if (req.query.expectedOwnerId !== String(req.user.id)) return res.status(403).json({code:'DRAFT_ACCOUNT_CHANGED',error:'The signed-in account changed.'});
  next();
}, limit, async (req,res) => {
  const controller = new AbortController();
  const cancel = () => { if (!res.writableEnded) controller.abort(); };
  res.on('close',cancel);
  try {
    const user = await require('../models/User').findById(req.user.id).select('preferences.aiEnabled').lean();
    if (!user || user.preferences?.aiEnabled === false) return res.status(403).json({code:'DICTATION_AI_DISABLED',error:'Enable AI in Settings to use dictation, or keep typing.'});
    const answer = await createMatterDictationSession(req.body?.sdp,{signal:controller.signal});
    if (!controller.signal.aborted) res.set('Cache-Control','no-store').json(answer);
  } catch(error) {
    if (!controller.signal.aborted) res.status(error.publicStatus || 503).json({code:'DICTATION_UNAVAILABLE',error:'Live dictation couldn’t connect. Your notes are unchanged.'});
  } finally { res.off('close',cancel); }
});
router.post('/', csrfProtection, (req, res, next) => {
  if (req.query.expectedOwnerId !== String(req.user.id)) return res.status(403).json({code:'DRAFT_ACCOUNT_CHANGED', error:'The signed-in account changed. Reload the editor before continuing.'});
  next();
}, limit, (req, res) => {
  receive(req, res, async error => {
    if (error) return res.status(error.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({error:'Use a recording smaller than 4 MB.'});
    const controller = new AbortController();
    const cancel = () => { if (!res.writableEnded) controller.abort(); };
    res.on('close', cancel);
    try {
      const user = await require('../models/User').findById(req.user.id).select('preferences.aiEnabled').lean();
      if (!user || user.preferences?.aiEnabled === false) return res.status(403).json({code:'DICTATION_AI_DISABLED', error:'Enable AI in Settings to use dictation, or keep typing.'});
      const text = await transcribeMatterNotes(req.file, {signal:controller.signal});
      if (!controller.signal.aborted) res.json({text});
    } catch (failure) {
      if (!controller.signal.aborted) res.status(failure.publicStatus || 503).json({
        code:failure.code || 'DICTATION_UNAVAILABLE',
        error:failure.code === 'DICTATION_EMPTY' ? 'No speech was detected. Try again or keep typing.' : failure.code === 'DICTATION_TOO_LONG' ? 'Use a shorter recording so the transcript fits your notes.' : 'Dictation is unavailable. Try again or keep typing.',
      });
    } finally {
      // Audio lives only in request memory; it never enters draft storage or logs.
      if (req.file?.buffer) req.file.buffer.fill(0);
      req.file = undefined;
      res.off('close', cancel);
    }
  });
});
module.exports = router;
