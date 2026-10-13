import test from 'node:test';
import assert from 'node:assert/strict';
import { isSupportPageAllowed } from '../../frontend/assets/scripts/utils/support-page-boundary.mjs';

test('public, authentication, and unknown pages cannot host Assistant', () => {
  for (const name of ['', 'index', 'terms', 'privacy', 'security', 'accessibility', 'contact', 'help', 'paralegalhelp', 'browse-paralegals', 'browse-jobs', 'profile-paralegal', 'profile-attorney', 'attorney-faq', 'paralegal-faq', 'paralegal-admission', 'login', 'signup', 'forgot-password', 'reset-password', 'verify-email', 'account-closure', 'director-portal', 'unknown']) {
    assert.equal(isSupportPageAllowed(`/${name}${name ? '.html' : ''}`), false, name);
  }
  assert.equal(isSupportPageAllowed('/public/attorney-v2.html'), false);
});
test('account workspaces retain Assistant access', () => {
  for (const name of ['admin-dashboard', 'admin-directors', 'attorney-v2', 'paralegal-v2', 'dashboard-attorney', 'dashboard-paralegal', 'profile-settings', 'case-detail', 'create-case', 'billing-attorney']) {
    assert.equal(isSupportPageAllowed(`/${name}.html`), true, name);
    assert.equal(isSupportPageAllowed(`/${name}`), true, name);
  }
});
