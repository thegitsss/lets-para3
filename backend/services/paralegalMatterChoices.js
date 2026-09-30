const mongoose = require('mongoose');
const { parseChoiceQuery, readCaseChoices, currentMatterScope } = require('./matterChoices');

// Switching current work requires an assignment. Applications, invitations,
// withdrawn assignments and revoked access never confer that relationship.
function readParalegalMatterChoices(ownerId, filters) {
  const variants = [new mongoose.Types.ObjectId(ownerId), ownerId, ownerId.toUpperCase()];
  return readCaseChoices(ownerId, filters, {
    $or: [{ paralegal: { $in: variants } }, { paralegalId: { $in: variants } }],
    paralegalAccessRevokedAt: null,
    ...currentMatterScope(),
  });
}
module.exports = { parseChoiceQuery, readParalegalMatterChoices };
