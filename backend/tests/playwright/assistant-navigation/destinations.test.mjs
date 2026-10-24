import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
const root=process.env.LPC_NAV_SOURCE_ROOT||path.resolve(import.meta.dirname,'../../../..');
const {adaptLegacyDestination:adapt}=await import(pathToFileURL(path.join(root,'frontend/assets/scripts/paralegal-v2/deep-links.mjs')).href);
const id='333333333333333333333333';
test('unknown own-workspace route prefixes cannot create destinations',()=>{
 for(const route of ['home-extra','browse-more','work-extra','settings-extra','helpdesk','profile/','attorney/','matter/','home/extra'])assert.equal(adapt(`/paralegal-v2.html#/${route}`),null,route);
});
test('own-workspace object routes require existing valid object identifiers',()=>{
 for(const kind of ['profile','attorney','matter'])for(const value of ['invalid','%ZZ','..','a'.repeat(25)])assert.equal(adapt(`/paralegal-v2.html#/${kind}/${value}`),null,`${kind}/${value}`);
});
test('existing exact routes and valid object destinations remain available',()=>{
 for(const route of ['home','browse','work?section=history','settings?tab=preferences','help',`profile/${id}`,`attorney/${id}`,`matter/${id}?tab=files`])assert.deepEqual(adapt(`/paralegal-v2.html#/${route}`),{href:`/paralegal-v2.html#/${route}`,internal:true});
});
test('existing legacy Matter and Settings mappings preserve context',()=>{
 assert.equal(adapt(`/case-detail.html?caseId=${id}#case-messages`).href,`/paralegal-v2.html#/matter/${id}?tab=messages`);
 assert.equal(adapt('/profile-settings.html?onboarding=success').href,'/paralegal-v2.html#/settings?tab=security&section=payments&stripe=success');
 assert.equal(adapt('/profile-settings.html?tab=preferences').href,'/paralegal-v2.html#/settings?tab=preferences');
 assert.equal(adapt('/paralegalhelp.html?incident=INC-20260909-000001').href,'/paralegal-v2.html#/help?incident=INC-20260909-000001');
});
test('unsupported roles and non-local schemes remain rejected',()=>{
 for(const href of ['/attorney-v2.html#/settings','/admin-dashboard.html','/unknown.html','https://example.test/profile-settings.html','//example.test/profile-settings.html','javascript:alert(1)','mailto:test@example.test/profile.html','/\\example.test/admin.html'])assert.equal(adapt(href),null,href);
});
test('only the existing public page allowlist remains outside V2',()=>{
 for(const page of ['privacy','terms','accessibility','contact','paralegal-admission','forgot-password'])assert.deepEqual(adapt(`/${page}.html`),{href:`/${page}.html`,internal:false});
 for(const page of ['login','attorney-faq','unknown','dashboard-attorney'])assert.equal(adapt(`/${page}.html`),null);
});
