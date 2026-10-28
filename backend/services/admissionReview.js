const { createHash } = require('node:crypto');

const qualifications = new Set(['certificate', 'degree', 'law_firm_experience']);
const methods = new Set(['issuing_institution', 'employer_contact', 'official_communication', 'reliable_documentation']);
const reviewedFields = ['role', 'status', 'email', 'emailVerified', 'disabled', 'deleted',
  'firstName', 'lastName', 'paralegalQualification', 'yearsExperience', 'resumeURL',
  'certificateURL', 'writingSampleURL', 'experience', 'education', 'bio', 'about', 'barNumber', 'barState'];

function snapshot(user) {
  const object = typeof user?.toObject === 'function' ? user.toObject() : user || {};
  return Object.fromEntries(reviewedFields.map(key => [key, object[key] ?? (
    ['emailVerified', 'disabled', 'deleted'].includes(key) ? false :
    ['experience', 'education'].includes(key) ? [] : key === 'yearsExperience' ? 0 : ''
  )]));
}

function admissionRevision(user) {
  return createHash('sha256').update(JSON.stringify(snapshot(user))).digest('hex');
}

function conflict(message, code = 'ADMISSION_REVIEW_CHANGED') {
  return Object.assign(new Error(message), { statusCode: 409, code });
}

function prepareQualificationReview(user, input, reviewedRevision) {
  if (user.deleted || user.disabled) throw conflict('This account is inactive. Review its access status before admission.');
  if (typeof reviewedRevision !== 'string' || reviewedRevision !== admissionRevision(user)) {
    throw conflict('This application needs a current review. Reopen it before approving.');
  }
  // The owner verifies credentials outside LPC; recording that process is optional.
  if (user.role !== 'paralegal' || input == null) return null;
  if (!input || input.confirmed !== true || !qualifications.has(input.qualification) || !methods.has(input.method)) {
    throw conflict('Record how you verified the applicant’s admission qualification before approving.', 'ADMISSION_QUALIFICATION_REVIEW_REQUIRED');
  }
  if (user.paralegalQualification && input.qualification !== user.paralegalQualification) {
    throw conflict('The verified qualification must match this application. Request a correction before approving.');
  }
  const evidence = typeof input.evidence === 'string' ? input.evidence.trim() : '';
  if (!evidence || evidence.length > 2000) {
    throw conflict('Describe the verification source and result in 2,000 characters or fewer.', 'ADMISSION_QUALIFICATION_REVIEW_REQUIRED');
  }
  if (input.qualification === 'law_firm_experience' && !(Number(user.yearsExperience) >= 1)) {
    throw conflict('At least one year of law-firm experience is required for this qualification.', 'ADMISSION_QUALIFICATION_INELIGIBLE');
  }
  if (['certificate', 'degree'].includes(input.qualification) && !user.certificateURL) {
    throw conflict('The qualifying certificate or degree document is missing.', 'ADMISSION_FILE_REQUIRED');
  }
  return { qualification: input.qualification, method: input.method, evidence, reviewedRevision };
}

// Match the reviewed fields as well as status: concurrent decisions or changed
// documents must lose the atomic claim even when timestamps share a millisecond.
function decisionFilter(user) {
  return { _id: user._id, $and: Object.entries(snapshot(user)).map(([key, value]) =>
    value === '' || value === false || value === 0 || (Array.isArray(value) && value.length === 0)
      ? { $or: [{ [key]: value }, { [key]: null }] }
      : { [key]: value }
  ) };
}

module.exports = { admissionRevision, prepareQualificationReview, decisionFilter, conflict };
