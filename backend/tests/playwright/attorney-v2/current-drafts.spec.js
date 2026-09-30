const { test, expect } = require('../support-session-fixture');
const { randomUUID } = require('node:crypto');
const AxeBuilder = require('@axe-core/playwright').default;
const { inventoryFixture } = require('./inventory-fixture');
const rows = page => page.locator('[data-table-body="draft"] .matter-queue-row');
const body = page => page.locator('[data-table-body="draft"]');
const fields = { title: 'Synthetic unfinished draft', practiceArea: 'Contract Law', state: 'New York', compAmount: '400.01', experience: '3+ years', deadline: '2027-03-14', description: 'First paragraph.\n\nSecond paragraph.', tasks: [{ title: 'Prepare agreement' }] };
async function api(page, method, path, data) {
  const csrf = await (await page.request.get('/api/csrf')).json(), user = (await (await page.request.get('/api/auth/me')).json()).user;
  const response = await page.request[method](path, { headers: { 'X-CSRF-Token': csrf.csrfToken }, ...(data ? { data: { ...data, expectedOwnerId: user.id || user._id } } : {}) });
  expect(response.ok(), `${method} ${path}: ${await response.text()}`).toBeTruthy(); return response.json();
}
async function install(page) {
  const user = (await (await page.request.get('/api/auth/me')).json()).user, owner = user.id || user._id;
  const data = { active: [], archived: [], drafts: { items: Array.from({ length: 203 }, (_, i) => ({ id: (i+1000).toString(16).padStart(24,'0'), title: `Draft ${String(i+1).padStart(3,'0')}`, status: 'draft', revision: 'a'.repeat(64), practiceArea: i ? 'Contract Law' : 'Estate planning', updatedAt: new Date(Date.UTC(2026,0,1,0,i)).toISOString() })) } };
  const state = { transform: value => value, status: 200, reads: [], respond: null };
  await page.route('**/api/cases/inventory?**', async route => {
    const url = new URL(route.request().url()); state.reads.push(Object.fromEntries(url.searchParams));
    if (state.respond) return state.respond(route, url);
    return route.fulfill({ status: state.status, contentType: 'application/json', body: JSON.stringify(state.transform(await inventoryFixture(data, owner, url.searchParams))) });
  });
  return { state, data };
}
async function ready(page) { await expect(body(page)).toHaveAttribute('aria-busy','false'); await expect(page.locator('[data-drafts-refresh]')).toBeVisible(); }

test('current drafts reach older pages with complete counts and persist filtering and page across reload', async ({ page }) => {
  const { state } = await install(page);
  await page.goto('/dashboard-attorney.html?draftPage=14#cases:draft', { waitUntil:'commit' }); await ready(page);
  await expect(rows(page)).toHaveCount(8); await expect(page.locator('[data-page-info="draft"]')).toHaveText('196–203 of 203');
  await expect(page.locator('[data-case-count="draft"]')).toHaveText('203');
  await expect(page.locator('[data-cases-search]')).toHaveAttribute('maxlength','200');
  await page.locator('[data-page-target="draft"][data-page-action="prev"]').click(); await ready(page);
  await expect(page).toHaveURL(/draftPage=13/); await expect(rows(page)).toHaveCount(15);
  await page.locator('[data-case-filter="active"]').click();
  await page.locator('[data-case-filter="draft"]').click(); await ready(page);
  await expect(page.locator('[data-page-info="draft"]')).toHaveText('181–195 of 203');
  await page.reload(); await ready(page); await expect(page.locator('[data-page-info="draft"]')).toHaveText('181–195 of 203');
  await page.locator('[data-cases-search]').fill('Draft 001'); await ready(page); await expect(rows(page)).toHaveCount(1);
  await expect(rows(page)).toContainText('Draft 001'); await expect(page.locator('[data-case-count="draft"]')).toHaveText('203');
  await page.reload(); await ready(page); await expect(rows(page)).toHaveCount(1);
  expect(state.reads.some(read => read.page==='14')).toBe(true);
});

for (const failure of ['network','malformed','published','wrong-owner']) test(`current draft ${failure} reads are unavailable and manually recover without false empty counts`, async ({ page }, info) => {
  const { state } = await install(page);
  if(failure==='network') state.status=503;
  else state.transform = value => failure==='malformed' ? {} : failure==='wrong-owner' ? {...value,ownerId:'f'.repeat(24)} : {...value,items:value.items.map(item=>({...item,publishedCaseId:'f'.repeat(24)}))};
  await page.goto('/dashboard-attorney.html#cases:draft', { waitUntil:'commit' });
  await expect(page.getByRole('button',{name:'Retry drafts',exact:true})).toBeVisible(); await expect(rows(page)).toHaveCount(0);
  await expect(page.getByRole('button',{name:'Refresh drafts',exact:true})).toBeHidden();
  await expect(page.locator('[data-case-count="draft"]')).toHaveText('—'); await expect(body(page)).not.toContainText('No unfinished');
  if(failure==='network') for(const [width,theme,text] of [[1440,'light','100%'],[390,'dark','100%'],[320,'dark','200%']]) {
    await page.setViewportSize({width,height:1000}); await page.evaluate(({theme,text})=>{window.applyThemePreference(theme);document.documentElement.style.fontSize=text;},{theme,text}); await page.waitForTimeout(350);
    await page.getByRole('button',{name:'Retry drafts',exact:true}).scrollIntoViewIfNeeded();
    const bounds=await page.getByRole('button',{name:'Retry drafts',exact:true}).boundingBox();expect(bounds.y).toBeGreaterThanOrEqual(0);expect(bounds.y+bounds.height).toBeLessThanOrEqual(1001);expect(bounds.height).toBeGreaterThanOrEqual(44);
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
    expect((await new AxeBuilder({page}).include('#matter-panel-draft').withTags(['wcag2a','wcag2aa','wcag21aa']).analyze()).violations).toEqual([]);
    await page.screenshot({path:info.outputPath(`unavailable-${width}-${theme}-${text}.png`),fullPage:true});
  }
  state.status=200;state.transform=value=>value;const retry=page.getByRole('button',{name:'Retry drafts',exact:true});await retry.focus();await retry.press('Enter');await ready(page);await expect(page.getByRole('button',{name:'Refresh drafts',exact:true})).toBeFocused();
  await expect(rows(page)).toHaveCount(15);await expect(page.locator('[data-case-count="draft"]')).toHaveText('203');
});

test('current refresh explains a removed final draft page and returns to the available last page', async ({ page }) => {
  const { data } = await install(page);await page.goto('/dashboard-attorney.html?draftPage=14#cases:draft',{waitUntil:'commit'});await ready(page);
  data.drafts.items=data.drafts.items.slice(0,20);await page.getByRole('button',{name:'Refresh drafts',exact:true}).click();
  await expect(page.getByRole('button',{name:'Go to the last page',exact:true})).toBeVisible();await expect(rows(page)).toHaveCount(0);
  await page.getByRole('button',{name:'Go to the last page',exact:true}).click();await ready(page);
  await expect(rows(page)).toHaveCount(5);await expect(page.locator('[data-page-info="draft"]')).toHaveText('16–20 of 20');
});

for (const current of [true,false]) for (const cleanup of [true,false]) test(`${current?'current':'V2'} published source is absent from drafts with ${cleanup?'completed':'interrupted'} cleanup and old links resolve exactly once`, async ({ page }) => {
  const title=`Publication draft ${randomUUID()}`;
  const draft=(await api(page,'post','/api/case-drafts',{...fields,title})).draft;
  const requestId=randomUUID(),publication=(await api(page,'post','/api/cases/posting/publications',{draftId:draft.id,revision:draft.revision,requestId,practiceArea:'contract law'})).publication;
  if(cleanup) await api(page,'post',`/api/cases/posting/publications/${requestId}/cleanup`,{});
  else await page.route('**/api/cases/posting/publications/*/cleanup',route=>route.fulfill({status:503,contentType:'application/json',body:'{}'}));
  let writes=0;page.on('request',request=>{if(request.method()==='POST'&&new URL(request.url()).pathname==='/api/cases/posting/publications') writes++;});
  await page.goto(current?`/dashboard-attorney.html?q=${encodeURIComponent(title)}#cases:draft`:`/attorney-v2.html#/matters?view=draft&q=${encodeURIComponent(title)}`,{waitUntil:'commit'});
  if(current){await ready(page);await expect(rows(page)).toHaveCount(0);}
  else {await expect(page.locator('[data-av2-region="matter-list"]')).toHaveAttribute('data-state','ready');await expect(page.locator('[data-av2-matter]')).toHaveCount(0);}
  await page.goto(current?`/create-case.html?draftId=${draft.id}#review`:`/attorney-v2.html#/matters/new?draftId=${draft.id}`,{waitUntil:'commit'});
  const outcome=page.getByRole('region',{name:'Publication status',exact:true});await expect(outcome).toHaveAttribute('data-state','complete');
  await expect(outcome.getByRole('link',{name:'Open posted Matter',exact:true})).toHaveAttribute('href',new RegExp(publication.caseId));
  if(!cleanup){const retained=await api(page,'get',`/api/case-drafts/${draft.id}`);expect(retained.draft.description).toBe(fields.description);expect(retained.draft.publishedCaseId).toBe(publication.caseId);}
  expect(writes).toBe(0);
});

test('typing during the first pending draft read selects the new query and ignores the delayed result', async ({ page }) => {
  const { state, data } = await install(page);
  const user=(await (await page.request.get('/api/auth/me')).json()).user,owner=user.id||user._id;
  let release,arrived;const gate=new Promise(resolve=>release=resolve),pending=new Promise(resolve=>arrived=resolve);
  state.respond=async(route,url)=>{
    const value=await inventoryFixture(data,owner,url.searchParams);
    if(!url.searchParams.get('q')){arrived();await gate;}
    await route.fulfill({contentType:'application/json',body:JSON.stringify(value)}).catch(()=>{});
  };
  try{
    await page.goto('/dashboard-attorney.html#cases:draft',{waitUntil:'commit'});await pending;
    await page.locator('[data-cases-search]').fill('Draft 001');await ready(page);await expect(rows(page)).toHaveCount(1);await expect(rows(page)).toContainText('Draft 001');
    release();await expect(page.locator('[data-cases-search]')).toHaveValue('Draft 001');await expect(rows(page)).toHaveCount(1);
  }finally{release();}
});

test('current account departure removes private draft rows and a delayed refresh cannot restore them', async ({ page }) => {
  const { state, data } = await install(page);await page.goto('/dashboard-attorney.html#cases:draft',{waitUntil:'commit'});await ready(page);
  const user=(await (await page.request.get('/api/auth/me')).json()).user,owner=user.id||user._id;
  let release,arrived;const gate=new Promise(resolve=>release=resolve),pending=new Promise(resolve=>arrived=resolve);
  state.respond=async(route,url)=>{const value=await inventoryFixture(data,owner,url.searchParams);arrived();await gate;await route.fulfill({contentType:'application/json',body:JSON.stringify(value)}).catch(()=>{});};
  try{
    await page.getByRole('button',{name:'Refresh drafts',exact:true}).click();await pending;
    await page.evaluate(()=>window.dispatchEvent(new CustomEvent('lpc:user-updated',{detail:{id:'f'.repeat(24),role:'attorney'}})));
    await expect(rows(page)).toHaveCount(0);release();await expect(page.getByRole('button',{name:'Retry drafts',exact:true})).toBeVisible();await expect(rows(page)).toHaveCount(0);
  }finally{release();}
});

test('current draft rows retain long titles and bounded actions in both themes and enlarged text', async ({ page }, info) => {
  test.setTimeout(90000);
  const { data }=await install(page);data.drafts.items=[{...data.drafts.items[0],title:'Review the services agreement for a new commercial engagement — Draft with complete saved detail',updatedAt:null,createdAt:null}];
  await page.goto('/dashboard-attorney.html#cases:draft',{waitUntil:'commit'});await ready(page);await expect(rows(page)).toHaveCount(1);
  await expect(rows(page)).not.toContainText(new Date().toLocaleDateString(undefined,{month:'short',day:'numeric',year:'numeric'}));
  await expect(rows(page)).not.toContainText('Edited —');
  await expect(rows(page).locator('.status')).toHaveCount(0);
  for(const [width,theme,text] of [[1440,'light','100%'],[1440,'dark','100%'],[390,'light','100%'],[390,'dark','100%'],[320,'light','200%'],[320,'dark','200%']]) {
    await page.setViewportSize({width,height:1000});await page.evaluate(({theme,text})=>{window.applyThemePreference(theme);document.documentElement.style.fontSize=text;},{theme,text});await page.waitForTimeout(350);
    const action=rows(page).getByRole('link',{name:'Continue draft',exact:true});await action.scrollIntoViewIfNeeded();
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
    for(const control of [action,rows(page).getByRole('button',{name:/More actions/})]) {
      const box=await control.boundingBox();expect(box.x).toBeGreaterThanOrEqual(0);expect(box.x+box.width).toBeLessThanOrEqual(width+1);expect(box.height).toBeGreaterThanOrEqual(44);
    }
    expect((await new AxeBuilder({page}).include('#matter-panel-draft').withTags(['wcag2a','wcag2aa','wcag21aa']).analyze()).violations).toEqual([]);
    await page.screenshot({path:info.outputPath(`draft-row-${width}-${theme}-${text}.png`),fullPage:true});
  }
  await rows(page).getByRole('button',{name:/More actions/}).click();await expect(rows(page).getByRole('button',{name:'Resume Draft',exact:true})).toHaveCount(0);await expect(rows(page).getByRole('button',{name:'Delete draft',exact:true})).toBeVisible();
});

test('draft retry does not take focus from another category selected while the read is pending', async ({ page }) => {
  const { state, data }=await install(page);state.status=503;await page.goto('/dashboard-attorney.html#cases:draft',{waitUntil:'commit'});
  const retry=page.getByRole('button',{name:'Retry drafts',exact:true});await expect(retry).toBeVisible();
  const user=(await (await page.request.get('/api/auth/me')).json()).user,owner=user.id||user._id;
  let release,arrived;const gate=new Promise(resolve=>release=resolve),pending=new Promise(resolve=>arrived=resolve);
  state.respond=async(route,url)=>{const value=await inventoryFixture(data,owner,url.searchParams);arrived();await gate;await route.fulfill({contentType:'application/json',body:JSON.stringify(value)});};
  try {
    await retry.focus();await retry.press('Enter');await pending;
    const active=page.locator('[data-case-filter="active"]');await active.focus();await active.press('Enter');release();
    await expect(page.locator('[data-case-count="draft"]')).toHaveText('203');await expect(active).toBeFocused();
  }finally{release();}
});

test('an older Case draft absent from the capped reader preserves its record and existing writer restrictions', async ({ page, baseURL }) => {
  // Both configurations own the disposable control-room database on 5889.
  expect(['http://127.0.0.1:5051', 'http://127.0.0.1:5888']).toContain(baseURL);
  const { MongoClient, ObjectId }=require('mongoose').mongo;
  const mongo=new MongoClient('mongodb://127.0.0.1:5889/control-room-playwright?directConnection=true',{serverSelectionTimeoutMS:5000});
  try {
    const title=`Earlier unfinished Matter ${randomUUID()}`;
    const draft=(await api(page,'post','/api/case-drafts',{...fields,title})).draft;
    const publication=(await api(page,'post','/api/cases/posting/publications',{draftId:draft.id,revision:draft.revision,requestId:randomUUID(),practiceArea:'contract law'})).publication;
    await mongo.connect();const db=mongo.db('control-room-playwright');
    // Convert only this newly created disposable record to the earlier Case-draft shape.
    expect((await db.collection('cases').updateOne({_id:new ObjectId(publication.caseId),title},{$set:{status:'draft'}})).modifiedCount).toBe(1);
    await page.route('**/api/cases/my?**',route=>route.fulfill({contentType:'application/json',body:'[]'}));
    await page.goto(`/dashboard-attorney.html?q=${encodeURIComponent(title)}#cases:draft`,{waitUntil:'domcontentloaded'});await ready(page);
    const row=rows(page);await expect(row).toHaveCount(1);await expect(row).toContainText(title);
    await expect(row.getByRole('link',{name:'Continue draft',exact:true})).toHaveAttribute('href',new RegExp(`^create-case\\.html\\?caseDraftId=${publication.caseId}&`));
    await row.getByRole('button',{name:/More actions/}).click();
    await expect(row.getByRole('button',{name:'Delete Matter',exact:true})).toHaveCount(0);
    await expect(row.getByRole('button',{name:'Edit Matter',exact:true})).toHaveCount(0);
    await row.getByRole('button',{name:'View Details',exact:true}).click();
    await expect(page.locator('.lpc-context-dialog')).toBeVisible();
    await expect(page.locator('#lpcContextTitle')).toHaveText(title);
    expect((await api(page,'get',`/api/cases/posting/${publication.caseId}`)).posting.values.description).toBe(fields.description);
    expect(await db.collection('cases').countDocuments({_id:new ObjectId(publication.caseId),status:'draft'})).toBe(1);
    expect(await db.collection('casedrafts').countDocuments({_id:new ObjectId(draft.id)})).toBe(1);
  } finally { await mongo.close(); }
});

test('a late initial draft count does not detach the active Matter action menu', async ({ page }) => {
  const draft=(await api(page,'post','/api/case-drafts',{...fields,title:`Active menu ${randomUUID()}`})).draft;
  const publication=(await api(page,'post','/api/cases/posting/publications',{draftId:draft.id,revision:draft.revision,requestId:randomUUID(),practiceArea:'contract law'})).publication;
  const {state,data}=await install(page),user=(await (await page.request.get('/api/auth/me')).json()).user,owner=user.id||user._id;
  data.active=[await api(page,'get',`/api/cases/${publication.caseId}`)];
  let release,arrived;const gate=new Promise(resolve=>release=resolve),pending=new Promise(resolve=>arrived=resolve);
  state.respond=async(route,url)=>{const value=await inventoryFixture(data,owner,url.searchParams);if(url.searchParams.get('view')==='draft'){arrived();await gate;}await route.fulfill({contentType:'application/json',body:JSON.stringify(value)});};
  try {
    await page.goto('/dashboard-attorney.html#cases:active',{waitUntil:'commit'});await pending;
    const row=page.locator(`[data-table-body="active"] .matter-queue-row[data-case-id="${publication.caseId}"]`);
    const menu=row.getByRole('button',{name:/More actions/});await menu.click();await expect(menu).toHaveAttribute('aria-expanded','true');
    release();await expect(body(page)).toHaveAttribute('aria-busy','false');await expect(page.locator('[data-case-count="draft"]')).toHaveText('203');
    await expect(menu).toHaveAttribute('aria-expanded','true');await expect(row.getByRole('button',{name:'Delete Matter',exact:true})).toBeVisible();
  }finally{release();}
});

test('current draft save returns to the complete older page and original filters without losing saved fields', async ({ page, baseURL }) => {
  // Both configurations own the disposable control-room database on 5889.
  expect(['http://127.0.0.1:5051', 'http://127.0.0.1:5888']).toContain(baseURL);
  const {MongoClient,ObjectId}=require('mongoose').mongo;
  const mongo=new MongoClient('mongodb://127.0.0.1:5889/control-room-playwright?directConnection=true',{serverSelectionTimeoutMS:5000});
  let collection, insertedIds=[];
  try {
    const user=(await (await page.request.get('/api/auth/me')).json()).user,owner=new ObjectId(user.id||user._id),prefix=`Return draft ${randomUUID()}`;
    await mongo.connect();collection=mongo.db('control-room-playwright').collection('casedrafts');
    const inserted=await collection.insertMany(Array.from({length:203},(_,i)=>({...fields,owner,title:`${prefix} ${String(i).padStart(3,'0')}`,status:'draft',publishedCaseId:null,__v:0,createdAt:new Date(Date.UTC(2026,0,1,0,i)),updatedAt:new Date(Date.UTC(2026,0,1,0,i))})));
    insertedIds=Object.values(inserted.insertedIds);
    const id=String(inserted.insertedIds[0]);
    const query=new URLSearchParams({q:prefix,matterPractice:'Contract Law',matterSort:'recent',draftPage:'14'}),destination=`/dashboard-attorney.html?${query}#cases:draft`;
    await page.goto(destination,{waitUntil:'domcontentloaded'});await ready(page);await expect(page.locator('[data-page-info="draft"]')).toHaveText('196–203 of 203');
    const row=page.locator(`[data-table-body="draft"] .matter-queue-row[data-case-id="${id}"]`);
    await expect(row.getByRole('link',{name:'Continue draft',exact:true})).toHaveAttribute('href',`create-case.html?${new URLSearchParams({draftId:id,returnTo:destination})}#description`);
    await row.getByRole('link',{name:'Continue draft',exact:true}).click();
    await expect(page.getByRole('region',{name:'Draft save status',exact:true})).toHaveAttribute('data-state','ready');
    expect(new URL(page.url()).searchParams.get('returnTo')).toBe(destination);
    await page.locator('#caseDescription').fill('Updated first paragraph.\n\nRetained second paragraph.');
    await page.getByRole('button',{name:'Save and Exit',exact:true}).click();
    await expect(page).toHaveURL(baseURL+destination);await page.waitForLoadState('domcontentloaded');await ready(page);
    await expect(page.locator('[data-page-info="draft"]')).toHaveText('196–203 of 203');
    const saved=(await api(page,'get',`/api/case-drafts/${id}`)).draft;
    expect(saved.description).toBe('Updated first paragraph.\n\nRetained second paragraph.');expect(saved.tasks.map(task=>task.title)).toEqual(fields.tasks.map(task=>task.title));expect(saved.compAmount).toBe(fields.compAmount);
    expect(await collection.countDocuments({owner,title:{$regex:`^${prefix}`}})).toBe(203);
  }finally{try{if(collection&&insertedIds.length)await collection.deleteMany({_id:{$in:insertedIds}});}finally{await mongo.close();}}
});

test('current publication outcome retains the restricted draft-list return context', async ({ page }) => {
  const draft=(await api(page,'post','/api/case-drafts',fields)).draft;
  await api(page,'post','/api/cases/posting/publications',{draftId:draft.id,revision:draft.revision,requestId:randomUUID(),practiceArea:'contract law'});
  const destination='/dashboard-attorney.html?q=Contract&matterPractice=Contract+Law&draftPage=14#cases:draft';
  await page.goto(`/create-case.html?draftId=${draft.id}&returnTo=${encodeURIComponent(destination)}#review`,{waitUntil:'commit'});
  const outcome=page.getByRole('region',{name:'Publication status',exact:true});await expect(outcome).toHaveAttribute('data-state','complete');
  await expect(outcome.getByRole('link',{name:'Return to Matters',exact:true})).toHaveAttribute('href',destination);
});
