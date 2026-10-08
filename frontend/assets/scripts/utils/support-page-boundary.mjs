// Public and unknown pages never host the account Assistant, even with a session.
const accountPages = new Set([
  'admin-dashboard', 'admin-directors',
  'attorney-v2', 'paralegal-v2', 'dashboard-attorney', 'dashboard-paralegal',
  'profile-settings', 'billing-attorney', 'active-cases', 'case-detail',
  'case-applications', 'paralegal-assigned', 'paralegal-invitations',
  'paralegal-applications', 'create-case', 'create-case-step2', 'create-case-step5',
]);

export function isSupportPageAllowed(pathname = '') {
  const match = /^\/([a-z0-9-]+)(?:\.html)?\/?$/i.exec(String(pathname));
  return Boolean(match && accountPages.has(match[1].toLowerCase()));
}
