const { test, expect } = require("./hiring-session-fixture.cjs");
const AxeBuilder = require("@axe-core/playwright").default;
const fulfill = (route, body, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
const payment = page => page.getByRole("region", { name: "Payment card details", exact: true });
const savedReturn = page => page.locator("[data-hiring-return]");
let para, paraId;
async function api(client, method, path, data) {
  const csrf = await (await client.get("/api/csrf")).json(), user = (await (await client.get("/api/auth/me")).json()).user;
  const response = await client[method](path, { headers: { "X-CSRF-Token": csrf.csrfToken }, ...(data ? { data: { ...data, expectedOwnerId: user.id || user._id } } : {}) });
  expect(response.ok(), `${method} ${path}: ${await response.text()}`).toBeTruthy(); return response.json();
}
async function application(page) {
  const fields = { title: "Synthetic card setup return", practiceArea: "Contract Law", state: "New York", compAmount: "400.01", experience: "3+ years", deadline: "2027-03-14", description: "Synthetic payment return verification", tasks: [{ title: "Prepare agreement" }] };
  const draft = (await api(page.request, "post", "/api/case-drafts", fields)).draft;
  const { publication } = await api(page.request, "post", "/api/cases/posting/publications", { draftId: draft.id, revision: draft.revision, requestId: require("crypto").randomUUID(), practiceArea: "contract law" });
  await api(page.request, "post", `/api/cases/${publication.caseId}/invite/${paraId}`, {}); await api(para, "post", `/api/cases/${publication.caseId}/invite/accept`, {}); return publication.caseId;
}
test.beforeEach(async ({ playwright, page }) => {
 const server=require('./hiring-session-fixture.cjs').getServer(),actor=await server.createUser('paralegal',{},true);paraId=actor.id;await require('../../../models/User').updateOne({_id:actor.id},{$set:{state:'NY',stateExperience:['NY'],practiceAreas:['Contract Law'],specialties:['Contract Law']}});
 para=await playwright.request.newContext({baseURL:server.origin,storageState:{cookies:[{...actor.cookie,domain:'127.0.0.1',path:'/',expires:-1,secure:false,url:undefined}],origins:[]}});
});
test.afterEach(async()=>para?.dispose());



async function mockCards(page) {
 const server=require('./hiring-session-fixture.cjs').getServer(),record={saves:0,starts:0,defaultCard:null},setups=new Map();
 server.provider.stripe.setupIntents.create=async(params,options)=>{record.starts++;expect(options.idempotencyKey).toBeTruthy();const value={id:'seti_hiringLocal',object:'setup_intent',customer:params.customer,metadata:params.metadata,status:'requires_payment_method',payment_method:null,livemode:false,client_secret:'seti_hiringLocal_secret_synthetic'};setups.set(value.id,value);server.provider.calls.push({method:'setupIntents.create',args:[params,options]});return structuredClone(value);};
 server.provider.stripe.setupIntents.retrieve=async id=>{expect(setups.has(id)).toBe(true);server.provider.calls.push({method:'setupIntents.retrieve',args:[id]});return structuredClone(setups.get(id));};
 page.on('request',request=>{if(request.method()==='POST'&&new URL(request.url()).pathname==='/api/payments/payment-method/default')record.saves++;});
 await page.exposeFunction('__confirmSyntheticProviderCard',()=>{const value=setups.get('seti_hiringLocal');expect(value).toBeTruthy();value.status='succeeded';value.payment_method='pm_hiringLocal';return {setupIntent:{id:value.id,status:value.status}};});
 await page.addInitScript(()=>{window.syntheticStripe={confirmations:0,destroyed:0};window.Stripe=()=>({elements:()=>({create:()=>{const events={};let host;return {on:(type,handler)=>events[type]=handler,mount:target=>{host=target;const label=document.createElement('label'),input=document.createElement('input');label.textContent='Synthetic provider card entry';label.append(input);input.addEventListener('input',()=>events.change?.({complete:input.value==='4242',empty:!input.value}));host.append(label);events.ready?.();},destroy:()=>{window.syntheticStripe.destroyed++;host?.replaceChildren();}};}}),confirmSetup:async options=>{window.syntheticStripe.confirmations++;window.syntheticStripe.returnUrl=options.confirmParams.return_url;return window.__confirmSyntheticProviderCard();}});});
 return record;
}
async function open(page, url = "/attorney-v2.html#/payments/setup") { await page.goto(url, { waitUntil: "domcontentloaded" }); await expect(payment(page)).toHaveAttribute("data-state", "ready"); }
async function verify(page) { await payment(page).getByRole("button", { name: "Add a payment card", exact: true }).click(); await page.getByLabel("Synthetic provider card entry").fill("4242"); await payment(page).getByRole("button", { name: "Verify card", exact: true }).click(); await expect(payment(page)).toHaveAttribute("data-state", "ready"); }












async function rollbackPolicy(page, record, version = 'legacy') {
  await page.route('**/api/auth/workspace-release', route => fulfill(route, { workspace: { schemaVersion: 1, ownerId: record.ownerId, role: 'attorney', revision: 1, version, defaultDestination: version === 'v2' ? '/attorney-v2.html#/home' : '/dashboard-attorney.html' } }));
}
const originalSetup = '/dashboard-attorney.html?cardSetup=1&workspace=legacy#funds';






const current=false;

test("card setup preserves the exact application until the attorney returns and clears it", async ({ page }) => {
  const record=await mockCards(page),id=await application(page);
  await page.goto(`/attorney-v2.html#/matters/${id}/applications?applicantId=${paraId}`);const applicationReview=page.locator(`[data-application="${paraId}"]`),process=applicationReview.locator('details[data-applicant-section="hiring"]');await process.locator(':scope > summary').click();await expect(process.locator('[data-hiring]')).toHaveAttribute('data-state','ready');
  if(!await savedReturn(page).count()){await process.getByRole('link',{name:'Add a payment card',exact:true}).click();const pending=await api(page.request,'get','/api/users/me/pending-hire?expectedOwnerId='+page.hiringActor.id);expect(pending.pending).toMatchObject({caseId:id,paralegalId:paraId});}
  else {await savedReturn(page).getByRole('button',{name:'Review card setup',exact:true}).click();await expect(savedReturn(page)).toHaveAttribute('data-state','ready');}
  if (await savedReturn(page).getByRole('button', { name: 'Add payment card', exact: true }).count()) await savedReturn(page).getByRole('button', { name: 'Add payment card', exact: true }).click();
  else {
    await expect(savedReturn(page)).toContainText('Another application is saved for card setup.');
    await savedReturn(page).getByRole('button', { name: 'Continue with this applicant', exact: true }).click(); await savedReturn(page).getByRole('button', { name: 'Continue to card setup', exact: true }).click();
  }
  await expect(payment(page)).toHaveAttribute("data-state", "ready");
  await expect(savedReturn(page)).toContainText("Synthetic card setup return"); await verify(page); expect(record.saves).toBe(0); await expect(payment(page)).toContainText("ending in 4242");
  await payment(page).getByRole("button", { name: "Set this card as default", exact: true }).click(); await expect(payment(page)).toHaveAttribute("data-state", "ready"); expect(record.saves).toBe(1); expect(record.starts).toBe(1);
  await expect(savedReturn(page).getByRole("link", { name: "Return to this application", exact: true })).toHaveAttribute("href", `#/matters/${id}/applications?applicantId=${paraId}`);
  await savedReturn(page).getByRole("link", { name: "Return to this application", exact: true }).click(); await expect(page.locator(`[data-application="${paraId}"]`)).toHaveAttribute("open", ""); const resumedProcess=page.locator(`[data-application="${paraId}"] details[data-applicant-section="hiring"]`);if(!await resumedProcess.evaluate(node=>node.open))await resumedProcess.locator(':scope > summary').click();await savedReturn(page).getByRole('button',{name:'Review card setup',exact:true}).click();await expect(savedReturn(page)).toHaveAttribute("data-state","ready");
  await savedReturn(page).getByRole("button", { name: "Clear saved application", exact: true }).click(); await savedReturn(page).getByRole("button", { name: "Clear selection", exact: true }).click();
  await expect(savedReturn(page).getByRole("button", { name: "Add payment card", exact: true })).toBeVisible(); await expect(savedReturn(page).getByRole("button", { name: "Clear saved application", exact: true })).toHaveCount(0);
  expect((await api(page.request, 'get', '/api/users/me/pending-hire?expectedOwnerId=' + (await (await page.request.get('/api/auth/me')).json()).user.id)).pending).toBeNull();
});

test('profile card setup confirms replacing another applicant and allows cancellation without a write',async({page})=>{
 const id=await application(page),otherId=await application(page),ownerId=page.hiringActor.id;
 const read=()=>api(page.request,'get',`/api/users/me/pending-hire?expectedOwnerId=${ownerId}`);
 const initial=await read();await api(page.request,'put','/api/users/me/pending-hire',{caseId:otherId,paralegalId:paraId,reviewedRevision:initial.revision});
 const User=require('../../../models/User'),storedBefore=(await User.collection.findOne({_id:new(require('mongoose').Types.ObjectId)(ownerId)})).pendingHire;
 const writes=[];page.on('request',request=>{if(request.method()==='PUT'&&new URL(request.url()).pathname==='/api/users/me/pending-hire')writes.push(request.postDataJSON());});
 const returnTo=`dashboard-attorney.html?caseId=${id}&applicantId=${paraId}&openApplicant=1#cases:inquiries`;
 await page.goto(`/profile-paralegal.html?paralegalId=${paraId}&returnTo=${encodeURIComponent(returnTo)}`);const trigger=page.getByRole('button',{name:/Hire for Synthetic card setup return|Review hire/,exact:true});await expect(trigger).toBeEnabled();await trigger.click();const dialog=page.getByRole('dialog'),selected=dialog.locator('[data-hiring-return]');await expect(selected).toHaveAttribute('data-state','ready');await expect(selected).toContainText('Another application is saved');
 await selected.getByRole('button',{name:'Continue with this applicant',exact:true}).click();await selected.getByRole('button',{name:'Cancel',exact:true}).click();expect(writes).toEqual([]);await expect(selected.getByRole('button',{name:'Continue with this applicant',exact:true})).toBeFocused();expect((await User.collection.findOne({_id:new(require('mongoose').Types.ObjectId)(ownerId)})).pendingHire).toEqual(storedBefore);
 await selected.getByRole('button',{name:'Continue with this applicant',exact:true}).click();await selected.getByRole('button',{name:'Continue to card setup',exact:true}).click();await expect(page).toHaveURL(/#\/payments\/setup$/);expect(writes).toHaveLength(1);expect(writes[0]).toMatchObject({expectedOwnerId:ownerId,caseId:id,paralegalId:paraId});expect((await read()).pending).toMatchObject({caseId:id,paralegalId:paraId});
});
