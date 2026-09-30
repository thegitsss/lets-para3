const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
function check(module, program, beforeImport = '') {
  const url = pathToFileURL(path.resolve(__dirname, '../../frontend/assets/scripts/utils', module)).href;
  execFileSync(process.execPath, ['--input-type=module', '--eval', `import assert from 'node:assert/strict'; ${beforeImport} const subject = await import(${JSON.stringify(url)}); const id='a'.repeat(24), other='b'.repeat(24); ${program}`], { stdio: 'pipe' });
}
test('both directions retain Matter and object identity for every shared tab', () => check('workspace-destinations.mjs', `
  for (const role of ['attorney','paralegal']) for (const tab of ['overview','work','messages','files','activity','financials',...(role==='paralegal'?['deadlines']:[])]) {
    const current=role==='attorney'?'/matters/'+id+'/'+tab:'/matter/'+id+'?tab='+tab;
    const target=subject.previousWorkspaceDestination(role,'/'+role+'-v2.html#'+current);
    assert.equal(target,'/case-detail.html?caseId='+id+'&tab='+tab);
    assert.equal(subject.currentWorkspaceDestination(role,target),'/'+role+'-v2.html#'+current);
  }
  const target=subject.previousWorkspaceDestination('attorney','/attorney-v2.html#/matters/'+id+'/messages?messageId='+other);
  assert.equal(new URL(target,'https://lpc.invalid').searchParams.get('messageId'),other);
`));
test('filtered Matter lists preserve typed filters, page and nested return through draft rollback', () => check('workspace-destinations.mjs', `
  const query=new URLSearchParams({view:'draft',q:'界'.repeat(200),matterPractice:'Contract Law',matterSort:'alphabetical',page:'19'});
  const current='/attorney-v2.html#/matters?'+query;
  const previous=subject.previousWorkspaceDestination('attorney',current);
  const parsed=new URL(previous,'https://lpc.invalid'); assert.equal(parsed.hash,'#cases:draft'); assert.equal(parsed.searchParams.get('draftPage'),'19'); assert.equal(parsed.searchParams.get('q'),'界'.repeat(200));
  const returned=new URLSearchParams(subject.currentWorkspaceDestination('attorney',previous).split('?')[1]);
  for(const [key,value] of query) assert.equal(returned.get(key),value);
  const editor='/attorney-v2.html#/matters/new?'+new URLSearchParams({caseDraftId:id,step:'review',returnTo:'#/matters?'+query});
  const old=new URL(subject.previousWorkspaceDestination('attorney',editor),'https://lpc.invalid');
  assert.equal(old.searchParams.get('caseDraftId'),id); assert.equal(old.hash,'#review'); assert.equal(old.searchParams.get('returnTo'),previous);
`));
test('routing refuses external, cross-role, ambiguous and invalid draft destinations', () => check('workspace-destinations.mjs', `
  for(const value of ['https://evil.test/attorney-v2.html#/home','//evil.test/attorney-v2.html#/home','https://u:p@lpc.invalid/attorney-v2.html#/home','/paralegal-v2.html#/home','/attorney-v2.html#/unknown','/attorney-v2.html#/matters/new?draftId=bad','/attorney-v2.html#/matters/new?draftId='+id+'&caseDraftId='+other,'/attorney-v2.html#/matters/new?draftId='+id+'&draftId='+other]) assert.equal(subject.previousWorkspaceDestination('attorney',value),null,value);
  assert.equal(subject.currentWorkspaceDestination('attorney','/dashboard-attorney.html?workspace=legacy#cases'),null);
  assert.equal(subject.currentWorkspaceDestination('attorney','/create-case.html?caseDraftId='+id+'&caseDraftId='+other),null);
`));
test('paralegal history, invitation and settings returns use actual original destinations', () => check('workspace-destinations.mjs', `
  for(const route of ['/work?section=history','/home?view=history','/payouts']) assert.equal(subject.previousWorkspaceDestination('paralegal','/paralegal-v2.html#'+route),'/dashboard-paralegal.html#cases-completed');
  assert.equal(subject.previousWorkspaceDestination('paralegal','/paralegal-v2.html#/work?section=invitations&matterId='+id),'/dashboard-paralegal.html?inviteCase='+id+'#cases');
  assert.equal(subject.previousWorkspaceDestination('paralegal','/paralegal-v2.html#/settings?tab=security&section=payments&stripe=complete'),'/profile-settings.html?role=paralegal&tab=security&section=payments&stripe=complete');
`));
test('decision validation binds approved presentation data to the verified owner and role', () => check('workspace-release.mjs', `
  const identity={id,role:'attorney'}, workspace={schemaVersion:1,ownerId:id,role:'attorney',revision:7,version:'v2',defaultDestination:'/attorney-v2.html#/home'};
  assert.equal(subject.workspaceDecision({workspace},identity).revision,7);
  for(const patch of [{ownerId:other},{role:'paralegal'},{revision:-1},{revision:1.5},{version:'other'},{defaultDestination:'https://evil.test/'}]) assert.throws(()=>subject.workspaceDecision({workspace:{...workspace,...patch}},identity));
`));
test('card setup returns to the original shared form with an explicit legacy entry', () => check('workspace-destinations.mjs', `
  for (const search of ['', '?hiringReturn=current']) assert.equal(subject.previousWorkspaceDestination('attorney','/attorney-v2.html'+search+'#/payments/setup'),'/dashboard-attorney.html?cardSetup=1&workspace=legacy#funds');
`));
test('only interaction in this dashboard document suppresses canonical entry', () => {
  const vm = require('node:vm'), source = require('node:fs').readFileSync(path.resolve(__dirname, '../../frontend/assets/scripts/utils/workspace-entry-guard.js'), 'utf8');
  for (const event of ['pointerdown', 'keydown', 'input', 'change', 'submit']) {
    const document = new EventTarget(), window = new EventTarget();
    vm.runInNewContext(source, { document, window, navigator: { userActivation: { hasBeenActive: true } } });
    expect(window.lpcWorkspaceEntryGuard.isUntouched()).toBe(true);
    document.dispatchEvent(new Event(event));
    expect(window.lpcWorkspaceEntryGuard.isUntouched()).toBe(false);
    window.lpcWorkspaceEntryGuard.dispose();
  }
});
test('document exit prevents late transport while restored history can verify its session again', () => check('document-navigation.mjs', `
  const win=new EventTarget();globalThis.window=win;let calls=0;globalThis.fetch=async()=>{calls++;return new Response('{}');};
  await subject.fetchInDocument('/api/auth/me');assert.equal(calls,1);
  win.dispatchEvent(new Event('pagehide'));await assert.rejects(subject.fetchInDocument('/api/auth/me'),{name:'AbortError'});assert.equal(calls,1);
  win.dispatchEvent(new Event('pageshow'));await assert.rejects(subject.fetchInDocument('/api/auth/me'),{name:'AbortError'});assert.equal(calls,1);
  win.dispatchEvent(Object.assign(new Event('pageshow'),{persisted:true}));await subject.fetchInDocument('/api/auth/me');assert.equal(calls,2);
  subject.markDocumentLeaving();win.dispatchEvent(new Event('pageshow'));await assert.rejects(subject.fetchInDocument('/api/auth/me'),{name:'AbortError'});assert.equal(calls,2);
`));
test('document lifecycle state is ready before a consuming shell handles exit or cached restoration', () => check('document-navigation.mjs', `
  let calls=0;const outcomes=[];globalThis.fetch=async()=>{calls++;return new Response('{}');};
  // Chromium invokes Window pageshow listeners in registration order even
  // when a later listener requests capture. The shell registers after import,
  // but before its first request initializes any lazy transport state.
  window.addEventListener('pagehide',()=>{assert.throws(()=>subject.assertDocumentActive(),{name:'AbortError'});});
  window.addEventListener('pageshow',event=>{if(event.persisted){try{subject.assertDocumentActive();outcomes.push('verify');}catch(error){outcomes.push(error.name);}}});
  await subject.fetchInDocument('/api/auth/me');assert.equal(calls,1);
  window.dispatchEvent(new Event('pagehide'));
  window.dispatchEvent(Object.assign(new Event('pageshow'),{persisted:true}));
  assert.deepEqual(outcomes,['verify']);
  await subject.fetchInDocument('/api/auth/me');assert.equal(calls,2);
`, 'globalThis.window = new EventTarget();'));
const harness = `
  const identity={id,role:'attorney',status:'approved'}, replacements=[], calls=[];
  let version='v2', dirty=false, failure=0, handler=null;
  class Element extends EventTarget { constructor(){super();this.children=[];this.dataset={};this.isConnected=false;} setAttribute(){} append(...nodes){this.children.push(...nodes);} prepend(node){node.isConnected=true;this.children.unshift(node);} remove(){this.isConnected=false;} }
  const doc=new EventTarget();doc.visibilityState='visible';doc.createElement=()=>new Element();doc.querySelectorAll=()=>[];
  const win=new EventTarget();Object.assign(win,{document:doc,location:{href:'https://lpc.invalid/attorney-v2.html#/matters/'+id+'/messages',origin:'https://lpc.invalid',hostname:'lpc.invalid',replace:value=>replacements.push(value)},setInterval:()=>1,clearInterval(){},setTimeout,clearTimeout,MutationObserver:class{observe(){}disconnect(){}},fetch:async(input,init)=>{calls.push({input,init});if(handler)return handler(input,init);return new Response(JSON.stringify({workspace:{schemaVersion:1,ownerId:id,role:'attorney',revision:1,version,defaultDestination:version==='v2'?'/attorney-v2.html#/home':'/dashboard-attorney.html'}}),{status:failure||200});}});
  const outlet=new Element();let losses=0;
  const controller=subject.createWorkspaceReleaseController({windowObject:win,outlet,baselineAllowed:()=>false,hasUnfinishedWork:()=>dirty,onAccessLost:()=>losses++});
`;
test('rollback retains unsent work, performs no write and changes presentation only when ready', () => check('workspace-release.mjs', harness + `
  assert.equal(await controller.start(identity),true);assert.equal(controller.hasPendingSwitch(),false);dirty=true;version='legacy';await controller.check();assert.equal(controller.hasPendingSwitch(),true);
  assert.equal(replacements.length,0);assert.match(outlet.children[0].children[1].textContent,/unsent text/);
  assert.ok(calls.every(call=>!call.init.method||call.init.method==='GET'));
  dirty=false;assert.equal(await controller.check(),false);assert.deepEqual(replacements,['/case-detail.html?caseId='+id+'&tab=messages']);controller.stop();assert.equal(controller.hasPendingSwitch(),false);
`));
test('an in-flight write and an unknown outcome are never replayed by rollback', () => check('workspace-release.mjs', harness + `
  await controller.start(identity);let release;const gate=new Promise(resolve=>release=resolve);
  handler=async(input)=>input==='/api/cases/change'?gate:new Response(JSON.stringify({workspace:{schemaVersion:1,ownerId:id,role:'attorney',revision:2,version:'legacy',defaultDestination:'/dashboard-attorney.html'}}));
  const write=controller.fetch('/api/cases/change',{method:'POST'});await controller.check();assert.equal(replacements.length,0);
  dirty=true;release(new Response('{}'));await write;await new Promise(resolve=>setTimeout(resolve,5));assert.equal(replacements.length,0);
  assert.equal(calls.filter(call=>call.init.method==='POST').length,1);dirty=false;await controller.check();assert.equal(replacements.length,1);controller.stop();
`));
test('failed policy read keeps current work; access loss uses the established authentication boundary', () => check('workspace-release.mjs', harness + `
  await controller.start(identity);failure=503;await controller.check();assert.equal(replacements.length,0);assert.match(outlet.children[0].children[0].textContent,/could not be checked/);
  failure=401;await controller.check();assert.equal(losses,1);assert.equal(replacements.length,0);controller.stop();
`));
test('a completed read allows a clean switch after a transient busy view without repeating the read', () => check('workspace-release.mjs', harness + `
  await controller.start(identity);dirty=true;version='legacy';await controller.check();assert.equal(replacements.length,0);
  await controller.fetch('/api/cases/review');dirty=false;
  await new Promise(resolve=>setTimeout(resolve,5));assert.equal(replacements.length,1);
  assert.equal(calls.filter(call=>call.input==='/api/cases/review').length,1);controller.stop();
`));
test('a response body arriving after its headers releases a settled view without a second request', () => check('workspace-release.mjs', harness + `
  await controller.start(identity);dirty=true;version='legacy';await controller.check();
  let body;handler=()=>new Response(new ReadableStream({start(value){body=value;}}));
  const response=await controller.fetch('/api/cases/review'), reading=response.json();
  await new Promise(resolve=>setTimeout(resolve,5));assert.equal(replacements.length,0);
  body.enqueue(new TextEncoder().encode('{}'));body.close();await reading;dirty=false;
  await new Promise(resolve=>setTimeout(resolve,5));assert.equal(replacements.length,1);
  assert.equal(calls.filter(call=>call.input==='/api/cases/review').length,1);controller.stop();
`));
test('late policy response cannot navigate a stopped or replaced session', () => check('workspace-release.mjs', harness + `
  let release;handler=()=>new Promise(resolve=>release=resolve);const pending=controller.start(identity);controller.stop();
  release(new Response(JSON.stringify({workspace:{schemaVersion:1,ownerId:id,role:'attorney',revision:2,version:'legacy',defaultDestination:'/dashboard-attorney.html'}})));
  assert.equal(await pending,false);assert.equal(replacements.length,0);
`));

test('conversation fallback retains the selected Matter and rejects ambiguous identity', () => check('workspace-destinations.mjs', `
  assert.equal(subject.previousWorkspaceDestination('paralegal','/paralegal-v2.html#/conversations?matter='+id),'/case-detail.html?caseId='+id+'&tab=messages');
  assert.equal(subject.previousWorkspaceDestination('attorney','/attorney-v2.html#/conversations?matter='+id),'/case-detail.html?caseId='+id+'&tab=messages');
  assert.equal(subject.previousWorkspaceDestination('attorney','/attorney-v2.html#/conversations?matter='+id+'&messageId='+other),'/case-detail.html?caseId='+id+'&tab=messages&messageId='+other);
  for(const query of ['matter=bad','matter='+id+'&matter='+other]) assert.equal(subject.previousWorkspaceDestination('attorney','/attorney-v2.html#/conversations?'+query),null);
`));

 test('modal recovery stays inside the active dialog and retains its draft destination', () => check('workspace-release.mjs', harness + `
  controller.stop();const modal=new Element();let open=true;
  const active=subject.createWorkspaceReleaseController({windowObject:win,outlet,baselineAllowed:()=>false,hasUnfinishedWork:()=>dirty,currentLocation:()=>open?'https://lpc.invalid/attorney-v2.html#/matters/new?draftId='+other:null,noticeHost:()=>open?modal:null});
  await active.start(identity);dirty=true;version='legacy';await active.check();
  assert.match(modal.children[0].children[1].textContent,/unsent text/);assert.equal(replacements.length,0);
  dirty=false;await active.check();assert.equal(new URL(replacements[0],win.location.origin).searchParams.get('draftId'),other);active.stop();
`));
