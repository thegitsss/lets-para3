import { parseRoute, legacyDestination, notificationDestination } from '../attorney-v2/routes.mjs';
import { safeMatterReturn, safeCurrentMatterReturn } from '../attorney-v2/matter-return.mjs';
import { adaptLegacyDestination } from '../paralegal-v2/deep-links.mjs';
import { parseRouteHash } from '../paralegal-v2/router.mjs';

const ID = /^[a-f\d]{24}$/i;
const TAB = new Set(['overview', 'applications', 'work', 'files', 'messages', 'deadlines', 'activity', 'financials']);
const text = value => typeof value === 'string' && value.length <= 2000 && !/[\\\x00-\x1f\x7f]/.test(value);
const locationFor = (value, origin) => {
  if (typeof value !== 'string' || value.length > 16000 || /[\\\x00-\x1f\x7f]/.test(value)) return null;
  try { const url = new URL(value, origin); return url.origin === origin && !url.username && !url.password ? url : null; } catch { return null; }
};
const href = url => `${url.pathname}${url.search}${url.hash}`;
function copy(source, target, keys) {
  for (const key of keys) if (source.getAll(key).length === 1 && text(source.get(key))) target.set(key, source.get(key));
}
function ids(source, target, keys) {
  for (const key of keys) if (source.getAll(key).length === 1 && ID.test(source.get(key) || '')) target.set(key, source.get(key));
}
function originalMatterList(query) {
  const safe = safeMatterReturn(`#/matters${query.size ? `?${query}` : ''}`);
  if (!safe) return '/dashboard-attorney.html#cases';
  const input = new URLSearchParams(safe.split('?')[1] || ''), output = new URL('/dashboard-attorney.html', 'https://lpc.invalid');
  const view = ({ applications: 'inquiries', inquiries: 'inquiries', archived: 'archived', draft: 'draft', active: 'active' })[input.get('view')] || 'active';
  output.hash = `cases:${view}`;
  copy(input, output.searchParams, ['q', 'matterPractice', 'matterDeadline', 'matterUpdated', 'matterSort', 'archiveStatus', 'openApplicant', 'openApplicants']);
  ids(input, output.searchParams, ['caseId', 'previewCaseId', 'highlightCase', 'applicantId', 'applicationId']);
  if (input.has('page')) output.searchParams.set(`${view}Page`, input.get('page'));
  return href(output);
}
function v2MatterList(url) {
  const output = new URLSearchParams();
  const view = ({ active: 'active', draft: 'draft', archived: 'archived', inquiries: 'applications' })[url.hash.split(':')[1]] || 'active';
  output.set('view', view);
  copy(url.searchParams, output, ['q', 'matterPractice', 'matterDeadline', 'matterUpdated', 'matterSort', 'archiveStatus', 'openApplicant', 'openApplicants']);
  ids(url.searchParams, output, ['caseId', 'previewCaseId', 'highlightCase', 'applicantId', 'applicationId']);
  const page = url.searchParams.get(`${view === 'applications' ? 'inquiries' : view}Page`);
  if (page) output.set('page', page);
  return safeMatterReturn(`#/matters?${output}`);
}

// Presentation routing only. Every destination still verifies its own account,
// record identity, role, revision and provider state through the existing APIs.
export function previousWorkspaceDestination(role, value, { origin = 'https://lpc.invalid', ownerId = '' } = {}) {
  if (!['attorney', 'paralegal'].includes(role)) return null;
  const url = locationFor(value, origin);
  if (!url || url.pathname !== `/${role}-v2.html`) return null;
  if (url.search && !(role === 'attorney' && url.hash === '#/payments/setup' && url.search === '?hiringReturn=current')) return null;
  if (role === 'attorney') {
    const route = parseRoute(url.hash); if (!route.found) return null;
    if (route.name === 'matters') return originalMatterList(route.query);
    if (route.name === 'conversations') {
      if (!route.query.has('matter')) return '/dashboard-attorney.html';
      const matter = route.query.get('matter');
      if (route.query.getAll('matter').length !== 1 || !ID.test(matter || '')) return null;
      const target = new URL('/case-detail.html', origin);
      target.searchParams.set('caseId', matter);
      target.searchParams.set('tab', 'messages');
      ids(route.query, target.searchParams, ['messageId']);
      return href(target);
    }
    const target = new URL(legacyDestination(route), origin);
    if (route.name === 'matter-downloads') {
      target.pathname = '/case-detail.html'; target.search = new URLSearchParams({ caseId: route.caseId, tab: 'files' }); target.hash = '';
      ids(route.query, target.searchParams, ['fileId']);
    }
    if (route.name === 'create') {
      target.pathname = '/create-case.html'; target.search = ''; target.hash = '';
      const draftKeys = ['draftId', 'caseDraftId', 'caseId'].filter(key => route.query.has(key));
      if (draftKeys.length > 1 || draftKeys.some(key => route.query.getAll(key).length !== 1 || !ID.test(route.query.get(key) || ''))) return null;
      ids(route.query, target.searchParams, draftKeys);
      const request = route.query.get('request');
      if (request) { if (!/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(request)) return null; target.searchParams.set('request', request); }
      const step = route.query.get('step'); if (['details', 'description', 'review'].includes(step)) { target.searchParams.set('step', step); target.hash = step; }
    }
    if (route.name === 'payment-setup') { target.pathname = '/dashboard-attorney.html'; target.search = '?cardSetup=1&workspace=legacy'; target.hash = 'funds'; }
    copy(route.query, target.searchParams, ['tab', 'panel', 'section', 'settingsTarget', 'from', 'payment', 'stripe', 'onboarding', 'onboardingStep', 'profilePrompt', 'incident']);
    const nested = safeMatterReturn(route.query.get('returnTo'));
    if (nested) target.searchParams.set('returnTo', originalMatterList(new URLSearchParams(nested.split('?')[1] || '')));
    return href(target);
  }
  const route = parseRouteHash(url.hash); if (!route.found) return null;
  const query = new URLSearchParams(route.query);
  let target;
  if (route.name === 'conversations') {
    if (!query.has('matter')) return '/dashboard-paralegal.html';
    const matter = query.get('matter');
    if (query.getAll('matter').length !== 1 || !ID.test(matter || '')) return null;
    target = new URL('/case-detail.html', origin);
    target.searchParams.set('caseId', matter);
    target.searchParams.set('tab', 'messages');
    ids(query, target.searchParams, ['messageId']);
  } else if (route.name === 'matter') {
    if (!ID.test(route.params.matterId || '')) return null;
    const tab = query.get('tab') || 'overview'; if (!TAB.has(tab)) return null;
    target = new URL(`/case-detail.html?caseId=${route.params.matterId}&tab=${tab}`, origin);
    ids(query, target.searchParams, ['applicantId', 'applicationId', 'fileId', 'messageId', 'eventId', 'taskId']);
  } else if (route.name === 'browse') {
    target = new URL('/browse-jobs.html', origin); copy(query, target.searchParams, ['practice', 'state', 'minPay', 'deadline', 'posted', 'sort', 'page']);
    if (ID.test(query.get('matterId') || '')) target.searchParams.set('caseId', query.get('matterId'));
  } else if (route.name === 'settings') {
    target = new URL('/profile-settings.html?role=paralegal', origin); copy(query, target.searchParams, ['tab', 'section', 'stripe', 'profilePrompt', 'onboarding', 'onboardingStep']);
  } else if (route.name === 'help') {
    target = new URL('/paralegalhelp.html', origin); copy(query, target.searchParams, ['incident']);
  } else if (route.name === 'attorney' || route.name === 'profile') {
    const id = route.name === 'attorney' ? route.params.attorneyId : route.params.profileId === 'me' ? ownerId : route.params.profileId;
    if (!ID.test(id || '')) return null;
    target = new URL(route.name === 'attorney' ? `/profile-attorney.html?id=${id}` : `/profile-paralegal.html?paralegalId=${id}`, origin);
  } else {
    target = new URL('/dashboard-paralegal.html', origin);
    if (route.name === 'work') {
      const section = query.get('section'); target.hash = section === 'history' ? 'cases-completed' : 'cases';
      ids(query, target.searchParams, ['applicationId', 'jobId']);
      if (ID.test(query.get('matterId') || '')) target.searchParams.set(section === 'invitations' ? 'inviteCase' : 'highlightCase', query.get('matterId'));
    }
    if (route.name === 'payouts') target.hash = 'cases-completed';
    if (route.name === 'home') {
      const view = query.get('view');
      if (view === 'history') target.hash = 'cases-completed';
      else if (['work', 'matters', 'board', 'document'].includes(view)) target.hash = 'cases';
      else if (view === 'deadlines') target.hash = 'home';
      const selected = /^(?:matter:)?([a-f\d]{24})$/i.exec(query.get('item') || '');
      if (selected) target.searchParams.set('highlightCase', selected[1]);
    }
  }
  return href(target);
}

export function currentWorkspaceDestination(role, value, { origin = 'https://lpc.invalid' } = {}) {
  const url = locationFor(value, origin); if (!url || !['attorney', 'paralegal'].includes(role)) return null;
  if (url.searchParams.get('workspace') === 'legacy') return null;
  if (role === 'paralegal') { const destination = adaptLegacyDestination(href(url)); return destination?.internal ? destination.href : null; }
  if (url.pathname === '/dashboard-attorney.html' && /^#cases(?::(?:active|draft|archived|inquiries))?$/.test(url.hash) && !['caseId', 'previewCaseId', 'highlightCase', 'openApplicant', 'openApplicants'].some(key => url.searchParams.has(key))) return `/attorney-v2.html${v2MatterList(url)}`;
  if (url.pathname === '/create-case.html') {
    const query = new URLSearchParams(), keys = ['draftId', 'caseDraftId', 'caseId'].filter(key => url.searchParams.has(key));
    if (keys.length > 1 || keys.some(key => url.searchParams.getAll(key).length !== 1 || !ID.test(url.searchParams.get(key) || ''))) return null;
    ids(url.searchParams, query, keys); copy(url.searchParams, query, ['request']);
    const step = url.searchParams.get('step') || url.hash.slice(1); if (['details', 'description', 'review'].includes(step)) query.set('step', step);
    const nested = safeCurrentMatterReturn(url.searchParams.get('returnTo'));
    if (nested) query.set('returnTo', v2MatterList(new URL(nested, origin)));
    return `/attorney-v2.html#/matters/new${query.size ? `?${query}` : ''}`;
  }
  const target = notificationDestination({ action: { href: href(url) } }, origin);
  return target?.internal ? target.href : null;
}
