const fs=require('node:fs/promises'),path=require('node:path'),assert=require('node:assert/strict');
const {parse}=require('@babel/parser');const {chromium,webkit}=require('playwright');const {expect}=require('playwright/test');
const root=path.resolve(__dirname,'../../../..');
(async()=>{
for(const engine of [chromium,webkit]){
 const browser=await engine.launch({headless:true});
 try{for(const role of ['attorney','paralegal']){
 const page=await browser.newPage();await page.route('http://legacy.test/**',r=>r.fulfill({contentType:'text/html',body:'<body></body>'}));await page.goto('http://legacy.test/');
 const source=await fs.readFile(root+`/frontend/assets/scripts/${role}-dashboard.js`,'utf8');
 const init=role==='attorney'?'initAttorneyTour':'initParalegalTour';
 const names=['updateOnboardingState','markTourCompleted',init];
 const functions=parse(source,{sourceType:'module'}).program.body.filter(n=>n.type==='FunctionDeclaration'&&names.includes(n.id.name)).map(n=>source.slice(n.start,n.end)).join('\n');
 const a=role==='attorney';
 const ids=a?['attorneyTourOverlay','attorneyTourModal','attorneyTourTooltip','attorneyTourStartBtn','attorneyTourCloseBtn','attorneyTourTooltipCloseBtn','attorneyTourBackBtn','attorneyTourNextBtn','attorneyTourStepTitle','attorneyTourStepText','headerUser']:['paralegalTourOverlay','paralegalTourModal','profileTourTooltip','startTourBtn','tourCloseBtn','tourTooltipCloseBtn','tourBackBtn','tourNextBtn','profileSettingsLink'];
 await page.evaluate(({ids,a})=>{document.body.innerHTML=ids.map(id=>`<${id.includes('Btn')?'button':'div'} id="${id}">${id}</${id.includes('Btn')?'button':'div'}>`).join('');const tip=document.getElementById(a?'attorneyTourTooltip':'profileTourTooltip');for(const id of ids.filter(id=>/BackBtn|NextBtn/.test(id)))tip.append(document.getElementById(id));}, {ids,a});
 await page.addScriptTag({content:`
 let tourApi=null,paralegalTourApi=null,tourInitialized=false,onboardingState={};
 window.writes=[];window.fail=true;window.updates=[];
 const normalizeOnboarding=x=>x;const getCachedOnboarding=()=>onboardingState;
 const getStoredUserSnapshot=()=>({role:'${role}',status:'approved',isFirstLogin:true});
 const loadOnboardingState=async()=>({});const getLocalTourCompleted=()=>false;
 const clearTourProgress=()=>{};const setTourProgress=()=>{};const setProfileMenuOpen=()=>{};
 const resolveStepTarget=step=>document.querySelector(step.selector||step.selectors?.[0]||'#missing');
 const activateDialogFocus=(el,opts)=>{window.escapeAction=opts.onEscape;opts.initialFocus?.focus();};const deactivateDialogFocus=()=>{};
 window.updateSessionUser=x=>updates.push(x);
 const secureFetch=async(url,options)=>{writes.push(options.body);return {ok:!fail,json:async()=>fail?{error:'synthetic failure'}:{onboarding:options.body}};};
 ${functions}
 window.begin=()=>${init}(getStoredUserSnapshot());
 window.advance=()=>${a?'tourApi.showStep(0)':'paralegalTourApi.showProfile()'};
 window.replay=()=>${a?'tourApi.start()':'paralegalTourApi.start()'};
 document.addEventListener('keydown',e=>{if(e.key==='Escape')window.escapeAction?.();});
 `});
 await page.evaluate(()=>begin());assert.equal(await page.evaluate(()=>writes.length),0,'intro must not write completion');
 await page.keyboard.press('Escape');assert.equal(await page.evaluate(()=>writes.length),0,'Escape must not complete');
 await page.evaluate(()=>{replay();advance();});
 const next=page.locator('#'+(a?'attorneyTourNextBtn':'tourNextBtn'));
 await next.click();await expect(page.locator('.tour-completion-error')).toBeVisible();
 assert.equal(await page.evaluate(()=>updates.length),0,'failed saves do not update session');
 await expect(next).toBeEnabled();await page.evaluate(()=>fail=false);
 let finalWriteConfirmed=false;
 if(!a)await page.route('**/profile-settings.html?tour=1',async r=>{finalWriteConfirmed=true;await r.fulfill({contentType:'text/html',body:'<p>Profile destination</p>'});});
 await next.click();
 if(a){await expect(page.locator('#attorneyTourOverlay')).not.toHaveClass(/is-active/);assert.equal(await page.evaluate(()=>writes.length),2);assert.equal(await page.evaluate(()=>updates[0].onboarding.attorneyTourCompleted),true);}
 else {await page.waitForURL(/profile-settings\.html/);assert.equal(finalWriteConfirmed,true);}
 console.log(engine.name()+' '+role+': actual tour intro/dismissal handlers, unconfirmed save, retry and confirmed completion passed');
 await page.close();
 }}finally{await browser.close();}
}
})().catch(e=>{console.error(e);process.exitCode=1;});
