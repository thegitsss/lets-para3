"use strict";

const { secureEvidenceTree } = require("./scripts/private-evidence");

class PrivateEvidenceReporter {
  onEnd() {
    secureEvidenceTree();
  }
}

module.exports = PrivateEvidenceReporter;
