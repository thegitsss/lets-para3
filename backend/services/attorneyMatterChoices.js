const mongoose = require('mongoose');
const { parseChoiceQuery, readCaseChoices, currentMatterScope } = require('./matterChoices');

// Private tasks can reference any owned Case, including historical records.
function readMatterChoices(ownerId, filters) {
  const variants = [new mongoose.Types.ObjectId(ownerId), ownerId, ownerId.toUpperCase()];
  return readCaseChoices(ownerId, filters, { $or: [{ attorney: { $in: variants } }, { attorneyId: { $in: variants } }] });
}
function readAttorneyWorkspaceChoices(ownerId, filters) {
  const variants = [new mongoose.Types.ObjectId(ownerId), ownerId, ownerId.toUpperCase()];
  return readCaseChoices(ownerId, filters, {
    $or: [{ attorney: { $in: variants } }, { attorneyId: { $in: variants } }],
    ...currentMatterScope(),
  });
}
module.exports = { parseChoiceQuery, readMatterChoices, readAttorneyWorkspaceChoices };
