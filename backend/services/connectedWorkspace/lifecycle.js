"use strict";
const Preparation = require("../../models/MatterPreparation");
const Vector = require("../../models/ParalegalSearchVector");
const EditorSession = require("../../models/DocumentEditorSession");
const CaseDraft = require("../../models/CaseDraft");
const Handoff = require("../../models/ClioHandoff");
const Transfer = require("../../models/ClioTransfer");
const clio = require("./clio");
// These records inherit existing account and Matter retention decisions. No
// new retention period or provider deletion policy is introduced here.
async function cleanupOwner(userId, { session } = {}) {
  await clio.cleanupOwner(userId, { session });
  await Vector.deleteMany({ userId }, { session });
  await EditorSession.deleteMany({ "participants.userId": userId }, { session });
}
async function cleanupMatter(caseId, { session } = {}) {
  const drafts = await CaseDraft.find({ publishedCaseId: caseId }).select("_id").session(session || null).lean();
  await Preparation.deleteMany({ caseId }, { session });
  await EditorSession.deleteMany({ caseId }, { session });
  await Transfer.deleteMany({ caseId }, { session });
  if (drafts.length) await Handoff.deleteMany({ draftId: { $in: drafts.map(draft => draft._id) } }, { session });
}
module.exports = { cleanupOwner, cleanupMatter };
