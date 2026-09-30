// Copy depends on the requested checks; it does not change eligibility or review rules.
export function preHiringRequestCopy(request = {}) {
  if (request.conflictsCheckRequired && request.confidentialityAgreementRequired) {
    return "The attorney needs to verify conflicts and review your confidentiality agreement before hiring.";
  }
  if (request.conflictsCheckRequired) return "The attorney needs to verify conflicts before hiring.";
  if (request.confidentialityAgreementRequired) return "The attorney needs your confidentiality agreement before hiring.";
  return "The attorney needs information before hiring.";
}
