const { test, expect } = require("../support-session-fixture"), AxeBuilder = require("@axe-core/playwright").default;
const json = (route, value, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(value) });
const panel = page => page.locator("[data-workspace-files]"), detail = page => panel(page).getByRole("region", { name: "Document review" });
const id = n => n.toString(16).padStart(24, "0");
const file = (n, patch = {}) => ({ id: id(n), name: `Lease exhibit ${n}.txt`, revision: "d".repeat(64), reviewRevision: "e".repeat(64), size: 40, version: 1, uploadedAt: null, securityStatus: "clean", status: "pending_review", uploadedByRole: "paralegal", notes: "", requestedAt: null, approvedAt: null, replacedAt: null, revisionOf: null, mimeType: "text/plain", canReview: true, ...patch });
async function fixture(page) {
  const user = (await (await page.request.get("/api/auth/me")).json()).user, ownerId = user.id || user._id;
  const csrf = await (await page.request.get("/api/csrf")).json(), fields = { title: "River Street lease — files", practiceArea: "Contract Law", state: "New York", compAmount: "400.01", experience: "3+ years", deadline: "2027-03-14", description: "Review the lease and its exhibits.", tasks: [{ title: "Review the lease" }] };
  const draftResponse = await page.request.post("/api/case-drafts", { headers: { "X-CSRF-Token": csrf.csrfToken }, data: { ...fields, expectedOwnerId: ownerId } }); expect(draftResponse.ok()).toBeTruthy(); const draft = (await draftResponse.json()).draft;
  const posted = await page.request.post("/api/cases/posting/publications", { headers: { "X-CSRF-Token": csrf.csrfToken }, data: { draftId: draft.id, revision: draft.revision, requestId: require("crypto").randomUUID(), practiceArea: "contract law", expectedOwnerId: ownerId } }); expect(posted.ok()).toBeTruthy(); const caseId = (await posted.json()).publication.caseId;
  const state = { upload: null, uploadWrites: [], uploadReads: 0, uploadRevision: "f".repeat(64), uploadFailure: false, uploadLost: false, uploadHeld: false, files: [file(100), file(99)], writes: [], error: false, lost: false, conflict: false, downloads: 0 };
  const pattern = `**/api/cases/${caseId}/files/review?**`;
  await page.route(pattern, route => {
    if (state.error) return json(route, {}, 503);
    const query = new URL(route.request().url()).searchParams, target = query.get("fileId"), cursor = query.get("cursor"), rows = state.files.filter(file => !cursor || file.id < cursor), files = rows.slice(0, 50), selectedFile = state.files.find(file => file.id === target) || null;
    return json(route, { caseId, ownerId, caseTitle: fields.title, access: "available", legacyAttachments: false, canUpload: true, files, nextCursor: rows.length > 50 ? files.at(-1).id : null, selection: target ? selectedFile ? "found" : "unavailable" : "none", selectedFile });
  });
  await page.route(`**/api/cases/${caseId}/files/*/review`, route => {
    const body = route.request().postDataJSON(); state.writes.push(body); const selected = state.files.find(file => route.request().url().includes(`/${file.id}/review`));
    if (state.conflict || body.reviewedRevision !== selected.reviewRevision) return json(route, { code: "DOCUMENT_CHANGED" }, 409);
    selected.status = body.status; selected.notes = body.notes; selected.reviewRevision = require("crypto").randomBytes(32).toString("hex"); selected.approvedAt = body.status === "approved" ? new Date().toISOString() : null; selected.requestedAt = body.status === "attorney_revision" ? new Date().toISOString() : null;
    return state.lost ? route.abort("failed") : json(route, { file: selected });
  });
  await page.route(`**/api/cases/${caseId}/downloads/*?**`, route => { state.downloads++; return route.fulfill({ contentType: "application/octet-stream", body: '<img src=x onerror="window.syntheticFileXss=true">\nExhibit B remains attached.' }); });
  await page.route(`**/api/uploads/case/${caseId}/upload-review?**`, route => { state.uploadReads++; if(state.uploadFailure)return json(route,{},503); const query=new URL(route.request().url()).searchParams;return json(route,{caseId,ownerId,revision:state.uploadRevision,canUpload: true,upload:query.get('requestId')?state.upload||{status:'missing',file:null,retryAllowed:true}:null}); });
  await page.route(`**/api/uploads/case/${caseId}/reviewed-upload`, async route => {
    const body=route.request().postDataBuffer().toString('utf8');const value=key=>body.match(new RegExp('name="'+key+'"\\r\\n\\r\\n([^\\r]+)'))?.[1]; state.uploadWrites.push({body,requestId:value('requestId'),ownerId:value('expectedOwnerId'),revision:value('reviewedRevision')});
    if(value('reviewedRevision')!==state.uploadRevision)return json(route,{code:'DOCUMENT_MATTER_CHANGED'},409);
    if(state.uploadHeld) await new Promise(resolve=>{state.releaseUpload=resolve;});
    if(state.uploadFailure){state.upload={status:'failed',file:null,retryAllowed:true};return json(route,{code:'FILE_UPLOAD_UNCONFIRMED'},503);}
    const saved=file(200,{name:'Lease.txt',uploadedByRole:'attorney',canReview:false});state.files.unshift(saved);state.upload={status:'recorded',file:saved,retryAllowed:false};return state.uploadLost?route.abort('failed'):json(route,state.upload);
  });
  await page.goto(`/attorney-v2.html#/matters/${caseId}/files`, { waitUntil: "domcontentloaded" }); await expect(panel(page)).toHaveAttribute("data-state", "ready"); await expect(page.locator("[data-file-upload]")).toHaveAttribute("data-state", "ready"); return { caseId, ownerId, state, pattern };
}
const upload=page=>page.locator('[data-file-upload]');
const select=async(page,name='Lease.txt',bytes='PRIVATE_UPLOAD_SENTINEL')=>{await upload(page).getByLabel('Choose document',{exact:true}).setInputFiles({name,mimeType:'text/plain',buffer:Buffer.from(bytes)});};
const share=async page=>{await upload(page).getByRole('button',{name:'Review selected document'}).click();await upload(page).getByRole('button',{name:'Confirm and share document'}).click();};
test('sharing requires an exact named confirmation and sends selected bytes only once',async({page})=>{
  const {caseId,state,ownerId}=await fixture(page),received=[],http=require('node:http');
  // Serve the unchanged app through a loopback proxy. Its same-origin receiver
  // observes native multipart bytes without Playwright's request-body inspector
  // or a cross-origin rewrite that WebKit correctly rejects under the app CSP.
  const server=http.createServer(async(req,res)=>{
    if(req.url!==`/api/uploads/case/${caseId}/reviewed-upload`){
      const upstream=http.request({hostname:'127.0.0.1',port:5051,path:req.url,method:req.method,headers:{...req.headers,host:'127.0.0.1:5051'},agent:false},result=>{res.writeHead(result.statusCode,result.headers);result.pipe(res);});
      upstream.on('error',()=>{if(!res.headersSent)res.writeHead(502);res.end();});res.on('close',()=>upstream.destroy());req.pipe(upstream);return;
    }
    const chunks=[];for await(const chunk of req)chunks.push(chunk);received.push(Buffer.concat(chunks).toString('utf8'));
    const saved=file(200,{name:'Lease.txt',uploadedByRole:'attorney',canReview:false});res.setHeader('Content-Type','application/json');res.end(JSON.stringify({status:'recorded',file:saved,retryAllowed:false}));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try {
    await page.unroute(`**/api/uploads/case/${caseId}/reviewed-upload`);
    await page.goto('http://127.0.0.1:'+server.address().port+'/attorney-v2.html#/matters/'+caseId+'/files',{waitUntil:'domcontentloaded'});await expect(upload(page)).toHaveAttribute('data-state','ready');
    await select(page);await upload(page).getByRole('button',{name:'Review selected document'}).click();await expect(upload(page)).toContainText('Share “Lease.txt”');expect(received).toHaveLength(0);
    await upload(page).getByRole('button',{name:'Confirm and share document'}).click();await expect(upload(page)).toContainText('Upload confirmed.');expect(received).toHaveLength(1);expect(received[0]).toContain(ownerId);expect(received[0]).toContain('f'.repeat(64));expect(received[0]).toContain('PRIVATE_UPLOAD_SENTINEL');expect(state.uploadWrites).toHaveLength(0);
    await expect(upload(page).getByRole('link',{name:'Open shared document'})).toHaveAttribute('href',/fileId=0000000000000000000000c8/);
  } finally {server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});
test('lost acknowledgement is checked without resending the file',async({page})=>{const {state}=await fixture(page);state.uploadLost=true;await select(page);await share(page);await expect(upload(page)).toContainText('could not be confirmed');expect(state.uploadWrites).toHaveLength(1);await upload(page).getByRole('button',{name:'Check saved upload'}).click();await expect(upload(page)).toContainText('Upload confirmed.');expect(state.uploadWrites).toHaveLength(1);});
test('explicit retry retains the original request ID and selected file',async({page})=>{const {state}=await fixture(page);state.uploadFailure=true;await select(page);await share(page);await expect(upload(page)).toContainText('could not be confirmed');state.uploadFailure=false;await upload(page).getByRole('button',{name:'Check saved upload'}).click();await expect(upload(page)).toContainText('no confirmed document');await upload(page).getByRole('button',{name:'Retry this file'}).click();await upload(page).getByRole('button',{name:'Confirm and share document'}).click();await expect(upload(page)).toContainText('Upload confirmed.');expect(state.uploadWrites).toHaveLength(2);expect(state.uploadWrites[0].requestId).toBeTruthy();expect(state.uploadWrites[0].requestId).toBe(state.uploadWrites[1].requestId);});
test('cancellation preserves uncertainty until the saved upload is checked',async({page})=>{const {state}=await fixture(page);state.uploadHeld=true;await select(page);await share(page);await expect.poll(()=>Boolean(state.releaseUpload)).toBe(true);await upload(page).getByRole('button',{name:'Stop waiting for upload'}).click();await expect(upload(page)).toContainText('file may still be saved');state.releaseUpload();await expect.poll(()=>state.upload?.status).toBe('recorded');await upload(page).getByRole('button',{name:'Check saved upload'}).click();await expect(upload(page)).toContainText('Upload confirmed.');expect(state.uploadWrites).toHaveLength(1);});
test('selection survives internal navigation and stays out of browser storage',async({page})=>{const {caseId,state}=await fixture(page);await select(page,'CONFIDENTIAL_LEASE.txt');await page.getByRole('navigation',{name:'Matter sections'}).getByRole('link',{name:'Work',exact:true}).click();await page.getByRole('navigation',{name:'Matter sections'}).getByRole('link',{name:'Files',exact:true}).click();await expect(upload(page)).toContainText('CONFIDENTIAL_LEASE.txt');expect(state.uploadWrites).toHaveLength(0);expect(await page.evaluate(()=>[...Object.values(localStorage),...Object.values(sessionStorage)].join(' '))).not.toMatch(/CONFIDENTIAL_LEASE|PRIVATE_UPLOAD_SENTINEL/);await upload(page).getByRole('button',{name:'Remove selection'}).click();await expect(upload(page)).not.toContainText('CONFIDENTIAL_LEASE.txt');expect(page.url()).toContain(caseId);});
test('unsupported and oversized selections cannot be submitted',async({page})=>{const {state}=await fixture(page);await select(page,'Lease.html');await expect(upload(page)).toContainText('supported image');await expect(upload(page).getByRole('button',{name:'Review selected document'})).toBeDisabled();await upload(page).getByLabel('Choose document',{exact:true}).setInputFiles({name:'Large.txt',mimeType:'text/plain',buffer:Buffer.alloc(20*1024*1024+1,65)});await expect(upload(page)).toContainText('no larger than 20 MB');await expect(upload(page).getByRole('button',{name:'Review selected document'})).toBeDisabled();expect(state.uploadWrites).toHaveLength(0);});
test('failed status reads keep the pending selection and block another send',async({page})=>{const {state}=await fixture(page);state.uploadLost=true;await select(page);await share(page);await expect(upload(page)).toContainText('could not be confirmed');state.uploadFailure=true;await upload(page).getByRole('button',{name:'Check saved upload'}).click();await expect(upload(page)).toContainText('status couldn’t load');await expect(upload(page).getByRole('button',{name:'Retry this file'})).toHaveCount(0);expect(state.uploadWrites).toHaveLength(1);});
test('account protection before the write clears the selected document',async({page})=>{const {state}=await fixture(page);await select(page,'CONFIDENTIAL_LEASE.txt');await upload(page).getByRole('button',{name:'Review selected document'}).click();await page.route('**/api/auth/me',route=>json(route,{user:{id:'9'.repeat(24),role:'attorney',status:'approved'}}));await upload(page).getByRole('button',{name:'Confirm and share document'}).click();await expect(upload(page)).toHaveCount(0);expect(state.uploadWrites).toHaveLength(0);await expect(page.locator('body')).not.toContainText('CONFIDENTIAL_LEASE.txt');});
test('selected-file review remains readable and accessible on phone and desktop',async({page},testInfo)=>{await fixture(page);await select(page,'Lease_exhibits_original_numbering_'.repeat(5)+'.txt');await upload(page).getByRole('button',{name:'Review selected document'}).click();await expect(upload(page)).toContainText('(23 bytes)');for(const width of [320,390,768,1366]){await page.setViewportSize({width,height:900});await upload(page).scrollIntoViewIfNeeded();expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);expect((await new AxeBuilder({page}).include('[data-file-upload]').withTags(['wcag2a','wcag2aa','wcag21aa']).analyze()).violations).toEqual([]);await page.screenshot({path:testInfo.outputPath('upload-'+width+'.png'),fullPage:true});}});

test('a background session refresh preserves confirmation and a stale revision requires an explicit recheck before retry',async({page})=>{
 const {state}=await fixture(page);await select(page);
 await upload(page).getByRole('button',{name:'Review selected document'}).click();
 await expect(upload(page).getByRole('button',{name:'Confirm and share document'})).toBeVisible();
 const confirmed=await upload(page).getByRole('button',{name:'Confirm and share document'}).elementHandle();
 const checked=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/auth/me');
 await page.evaluate(()=>window.dispatchEvent(new Event('focus')));await checked;
 await expect(upload(page).getByRole('button',{name:'Confirm and share document'})).toBeVisible();
 expect(state.uploadWrites).toHaveLength(0);
 expect(await confirmed.evaluate(e=>e.isConnected)).toBe(true);
 state.uploadRevision='a'.repeat(64);
 await upload(page).getByRole('button',{name:'Confirm and share document'}).click();
 await expect(upload(page)).toContainText('The Matter or upload changed. Check the saved upload before continuing.');
 await expect(upload(page).getByRole('button',{name:'Confirm and share document'})).toHaveCount(0);
 await expect(upload(page)).toContainText('Lease.txt');expect(state.uploadWrites).toHaveLength(1);expect(state.upload).toBeNull();
 await upload(page).getByRole('button',{name:'Check saved upload'}).click();
 await upload(page).getByRole('button',{name:'Retry this file'}).click();
 await expect(upload(page).getByRole('button',{name:'Confirm and share document'})).toBeVisible();
 await upload(page).getByRole('button',{name:'Confirm and share document'}).click();
 await expect(upload(page)).toContainText('Upload confirmed.');expect(state.uploadWrites).toHaveLength(2);
 expect(state.uploadWrites[1].revision).toBe(state.uploadRevision);expect(state.uploadWrites[1].requestId).toBe(state.uploadWrites[0].requestId);
});
