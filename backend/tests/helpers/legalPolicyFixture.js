const { recordSignupPolicyAcknowledgement } = require("../../utils/legalDocuments");

// Existing engagement tests seed fully admitted members. Acceptance-specific
// suites deliberately create unacknowledged users instead of using this helper.
module.exports = () => recordSignupPolicyAcknowledgement({});
