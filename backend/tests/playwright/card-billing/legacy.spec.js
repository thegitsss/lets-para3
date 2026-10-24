const {test,expect,original,OWNER,OTHER,MATTER,json}=require('./fixture');
const AxeBuilder=require('@axe-core/playwright').default;
test('original Payments has one card setup entry and preserves an exact saved application without clearing or hiring',async({page})=>{
 const {state,panel}=await original(page);state.pending={state:'available',caseId:MATTER,paralegalId:OTHER,caseTitle:'River Street matter',paralegalName:'Priya Ng'};
 await page.reload();await expect(panel).toHaveAttribute('data-state','ready');await expect(panel.getByText(/ending in 4242/)).toHaveCount(1);
 await expect(page.locator('[data-payment-card-host]').getByRole('link',{name:'Return to this application',exact:true})).toHaveAttribute('href',`/attorney-v2.html#/matters/${MATTER}/applications?applicantId=${OTHER}`);
 await expect(panel.getByRole('link',{name:'Manage card',exact:true})).toHaveAttribute('href','/attorney-v2.html#/payments/setup');await expect(page.locator('#paymentMethodModal')).toHaveCount(0);await expect(page.locator('#openPortalTopBtn')).toHaveCount(0);
 expect(state.starts).toEqual([]);expect(state.saves).toEqual([]);expect(state.account.posts).toEqual([]);
});
test('unavailable original card reads clear stale card details and cannot become an empty saved card',async({page})=>{
 const {state,panel}=await original(page);state.defaultStatus=502;await panel.getByRole('button',{name:'Check saved card',exact:true}).click();await expect(panel).toHaveAttribute('data-state','error');await expect(panel).not.toContainText('4242');await expect(panel).not.toContainText('No default payment card');await expect(panel.getByRole('button',{name:'Open Stripe billing',exact:true})).toBeHidden();
});
test('original billing requires explicit handoff, preserves request identity on retry, and rejects unsafe URLs',async({page})=>{
 const {state,panel}=await original(page);const open=panel.getByRole('button',{name:'Open Stripe billing',exact:true});await open.click();expect(state.portals).toHaveLength(0);await panel.getByRole('button',{name:'Stay in Payments',exact:true}).click();await expect(open).toBeFocused();
 state.portalStatus=502;await open.click();await panel.getByRole('button',{name:'Continue to Stripe',exact:true}).click();await expect(panel.getByRole('button',{name:'Try opening billing again',exact:true})).toBeVisible();
 state.portalStatus=200;state.url='https://billing.stripe.com.evil.test/p/session/unsafe';await panel.getByRole('button',{name:'Try opening billing again',exact:true}).click();await expect(panel).toContainText('Stripe billing couldn’t open.');expect(state.portals).toHaveLength(2);expect(state.portals[0].body).toEqual(state.portals[1].body);expect(state.portals[0].body.expectedOwnerId).toBe(OWNER);expect(state.portals[0].csrf).toBeTruthy();await expect(page).toHaveURL(/dashboard-attorney.html#funds$/);
});
test('original card details and billing handoff disappear after account replacement during provider work',async({page})=>{
 const {state,panel}=await original(page);state.portalRespond=async route=>{state.account.user={...state.account.user,id:OTHER,_id:OTHER};return json(route,{ownerId:OWNER,url:state.url});};
 await panel.getByRole('button',{name:'Open Stripe billing',exact:true}).click();await panel.getByRole('button',{name:'Continue to Stripe',exact:true}).click();await expect(page).toHaveURL(/\/login.html/);expect(state.portals).toHaveLength(1);
});
test('an original setup callback removes credentials before API calls and checks the existing setup without saving a card',async({page})=>{
 const {state}=await original(page,{saved:false});const referrers=[];page.on('request',r=>{if(r.url().includes('/api/'))referrers.push(r.headers().referer||'');});
 await page.goto('/dashboard-attorney.html?setup_intent=seti_synthetic&setup_intent_client_secret=synthetic-private&redirect_status=succeeded#funds');
 await expect(page).toHaveURL(/attorney-v2.html#\/payments\/setup$/);await expect(page.getByRole('button',{name:'Set this card as default',exact:true})).toBeVisible();expect(state.reads).toContain('setup');expect(state.saves).toEqual([]);expect(state.starts).toEqual([]);expect(referrers.some(value=>value.includes('synthetic-private'))).toBe(false);
});
for(const theme of ['light','dark'])test(`original ${theme} card and billing controls remain readable and usable at mobile and enlarged desktop sizes`,async({page},info)=>{
 await page.setViewportSize({width:390,height:900});const {panel}=await original(page,{theme});
 for(const width of [320,390,1440]){
  await page.setViewportSize({width,height:1000});await page.evaluate(()=>document.documentElement.style.fontSize='20px');await panel.scrollIntoViewIfNeeded();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
  for(const control of await panel.locator('button:visible,a:visible').all()){const box=await control.boundingBox();expect(box.height).toBeGreaterThanOrEqual(43.5);expect(box.x).toBeGreaterThanOrEqual(0);expect(box.x+box.width).toBeLessThanOrEqual(width+1);}
  await panel.getByRole('button',{name:'Open Stripe billing',exact:true}).click();await expect(panel.getByRole('button',{name:'Continue to Stripe',exact:true})).toBeFocused();
  const result=await new AxeBuilder({page}).include('[data-payment-card-host]').withTags(['wcag2a','wcag2aa','wcag21aa']).analyze();expect(result.violations).toEqual([]);
  await page.screenshot({path:info.outputPath(`original-card-${theme}-${width}.png`),fullPage:true});await panel.getByRole('button',{name:'Stay in Payments',exact:true}).click();
 }
 const bg=await page.locator('[data-payment-card-host]').evaluate(node=>getComputedStyle(node).backgroundColor);if(theme==='dark')expect(bg).not.toBe('rgb(255, 255, 255)');
});
