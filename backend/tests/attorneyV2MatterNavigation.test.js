const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const url = name => pathToFileURL(path.resolve(__dirname, `../../frontend/assets/scripts/attorney-v2/${name}.mjs`)).href;
const check = source => { execFileSync(process.execPath, ['--input-type=module', '--eval', `import assert from 'node:assert/strict';import * as r from ${JSON.stringify(url('matter-return'))};import {matterLink} from ${JSON.stringify(url('workspace-model'))};import {parseRoute} from ${JSON.stringify(url('routes'))};import {candidateHref,safeCandidateReturn} from ${JSON.stringify(url('candidate-model'))};const caseId='a'.repeat(24),applicantId='b'.repeat(24),applicationId='c'.repeat(24);${source}`], { stdio: 'pipe' }); };

test('Matter returns preserve the exact valid query order, filters, page and selected row', () => check(`
  const href='#/matters?view=archived&q=Contract+review&matterPractice=Contract+Law&matterDeadline=7_days&matterUpdated=30_days&matterSort=alphabetical&archiveStatus=completed&page=200001&highlightCase='+caseId;
  assert.equal(r.safeMatterReturn(href),href);assert.equal(r.matterReturnHref({query:new URLSearchParams({returnTo:href})}),href);assert.equal(safeCandidateReturn(href),href);
  const entry=r.withMatterReturn('#/matters/'+caseId+'/manage',parseRoute(href));assert.equal(parseRoute(entry).query.get('returnTo'),href);
  const follow=r.withMatterReturn('#/matters/new?caseId='+caseId,parseRoute(entry));assert.equal(parseRoute(follow).query.get('returnTo'),href);assert.equal(parseRoute(follow).query.get('caseId'),caseId);
`));
test('external, recursive, alternate-page and malformed returns cannot leave the Matter list boundary', () => check(`
  for(const value of ['https://outside.test','#/matters/'+caseId+'/overview','#/settings','#/mattersevil','#/matters#https://outside.test','#/matters?q=bad'+String.fromCharCode(0),'//outside.test']) assert.equal(r.safeMatterReturn(value),null);
  const output=r.safeMatterReturn('#/matters?view=active&returnTo=https%3A%2F%2Foutside.test&next=bad&page=1000001&q=okay');
  assert.equal(output,'#/matters?view=active&q=okay');assert.equal(r.matterReturnHref({query:new URLSearchParams({returnTo:'https://outside.test'})}),'#/matters');
  assert.equal(r.safeMatterReturn('#/matters?view=active&view=archived&page=2&page=3'),'#/matters');
`));
test('a nested candidate return retains the selected application and original list without recursive redirects', () => check(`
  const list='#/matters?view=applications&q=Contract&page=2&caseId='+caseId+'&openApplicant=1';
  const query=new URLSearchParams({applicantId,applicationId,appPage:'3',appSort:'name',appStatus:'submitted',appSearch:'Alex',returnTo:list});
  const review=matterLink(caseId,'applications',query),profile=candidateHref(applicantId,new URLSearchParams({caseId,applicantId,applicationId,returnTo:review}));
  const back=parseRoute(parseRoute(profile).query.get('returnTo'));assert.equal(back.caseId,caseId);assert.equal(back.query.get('applicationId'),applicationId);assert.equal(back.query.get('applicantId'),applicantId);assert.equal(back.query.get('appPage'),'3');assert.equal(back.query.get('appSearch'),'Alex');assert.equal(back.query.get('returnTo'),list);
  assert.equal(r.matterReturnHref(back),list);
  const nested=safeCandidateReturn('#/matters/'+caseId+'/applications?returnTo='+encodeURIComponent(review));assert.equal(parseRoute(nested).query.has('returnTo'),false);
`));
test('changing workspace tabs retains both review filters and the list context without granting an action', () => check(`
  const list='#/matters?view=archived&page=2';
  const query=new URLSearchParams({returnTo:list,appPage:'4',appSort:'oldest',appStatus:'withdrawn',appSearch:'Name',invPage:'3',invSort:'name',invStatus:'declined',invSearch:'Other',fileId:applicationId});
  for(const tab of ['overview','applications','work','files','messages','deadlines','activity','financials']) {
    const route=parseRoute(matterLink(caseId,tab,query));assert.equal(route.caseId,caseId);assert.equal(route.tab,tab);assert.equal(route.query.get('returnTo'),list);
    for(const key of ['appPage','appSort','appStatus','appSearch','invPage','invSort','invStatus','invSearch','fileId']) assert.equal(route.query.get(key),query.get(key));
  }
`));
test('directory profile returns retain the originating invitation review and list with a bounded nesting depth', () => check(`
  const list='#/matters?view=active&q=Original&page=2';
  const review='#/matters/'+caseId+'/invitations?'+new URLSearchParams({invPage:'2',invStatus:'declined',returnTo:list});
  const directory='#/paralegals?'+new URLSearchParams({caseId,q:'Alex',page:'3',returnTo:review});
  const profile=candidateHref(applicantId,new URLSearchParams({caseId,returnTo:directory}));
  const back=parseRoute(parseRoute(profile).query.get('returnTo'));assert.equal(back.name,'paralegals');assert.equal(back.query.get('q'),'Alex');assert.equal(back.query.get('page'),'3');
  const invitation=parseRoute(back.query.get('returnTo'));assert.equal(invitation.caseId,caseId);assert.equal(invitation.query.get('invPage'),'2');assert.equal(invitation.query.get('returnTo'),list);
  const recursive=safeCandidateReturn('#/paralegals?'+new URLSearchParams({returnTo:directory}));assert.equal(parseRoute(recursive).query.has('returnTo'),false);
`));
test('valid international search text survives encoded directory and Matter returns', () => check(`
  const search='案'.repeat(200),list='#/matters?'+new URLSearchParams({view:'active',q:search,matterPractice:search,page:'2'});
  const review='#/matters/'+caseId+'/invitations?'+new URLSearchParams({returnTo:list});
  const directory='#/paralegals?'+new URLSearchParams({caseId,q:search,returnTo:review});
  const profile=candidateHref(applicantId,new URLSearchParams({caseId,returnTo:directory}));
  const back=parseRoute(parseRoute(profile).query.get('returnTo'));assert.equal(back.query.get('q'),search);assert.equal(parseRoute(back.query.get('returnTo')).query.get('returnTo'),list);
  assert.equal(safeCandidateReturn('#/paralegals?'+ 'q='+'x'.repeat(16000)),null);
`));
test('draft list returns stay drafts while direct creation retains its existing default', () => check(`
  const list='#/matters?view=draft&q=Private&page=8',route=parseRoute(list),href=r.withMatterReturn('#/matters/new?draftId='+caseId+'&step=description',route);
  assert.equal(r.matterReturnHref(parseRoute(href),'#/matters?view=draft'),list);assert.equal(r.matterReturnHref(parseRoute('#/matters/new'),'#/matters?view=draft'),'#/matters?view=draft');
  assert.equal(r.withMatterReturn('/create-case.html',route),'/create-case.html');assert.equal(r.withMatterReturn('#/matters/'+caseId+'/overview',parseRoute('#/home')),'#/matters/'+caseId+'/overview');
`));

test('Matter returns retain reverse sort directions', () => check(`
for(const sort of ['recent_reverse','deadline_reverse','status_reverse','alphabetical_reverse']) {
const href='#/matters?view=active&matterSort='+sort+'&page=2';assert.equal(r.safeMatterReturn(href),href);
assert.equal(parseRoute(r.withMatterReturn('#/matters/'+caseId+'/overview',parseRoute(href))).query.get('returnTo'),href);
}
`));

test('a saved-paralegal profile returns to the saved list without accepting arbitrary destinations', () => check(`
  const back=safeCandidateReturn('#/paralegals?view=saved');
  assert.equal(parseRoute(back).query.get('view'),'saved');
  assert.equal(parseRoute(candidateHref(applicantId,new URLSearchParams({returnTo:back}))).query.get('returnTo'),back);
  assert.notEqual(parseRoute(safeCandidateReturn('#/paralegals?view=private-admin')).query.get('view'),'private-admin');
`));
