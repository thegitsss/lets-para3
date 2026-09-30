const {test,expect,fixture,inspect,OWNER,MATTER}=require('./fixture');
const AxeBuilder=require('@axe-core/playwright').default;
test('only an explicit reviewed action opens the same Stripe Checkout',async({page})=>{
 const {state,panel}=await fixture(page);expect(state.reads).toEqual([]);expect(state.posts).toEqual([]);await expect(panel.getByRole('button',{name:'Continue with Stripe',exact:true})).toHaveCount(0);
 for(const amount of ['$400.00','$88.00','$488.00'])await expect(panel.getByText(amount,{exact:true})).toHaveCount(1);
 await inspect(panel);expect(state.reads).toEqual([{expectedOwnerId:OWNER}]);await expect(panel.locator('[data-funding-message]')).toBeFocused();expect(state.posts).toEqual([]);
 await page.route('https://checkout.stripe.com/**',route=>route.fulfill({contentType:'text/html',body:'<title>Private synthetic Stripe destination</title>'}));
 await panel.getByRole('button',{name:'Continue with Stripe',exact:true}).click();await expect(page).toHaveURL(state.url);expect(state.posts).toEqual([{body:{reviewedRevision:'b'.repeat(64),expectedOwnerId:OWNER},csrf:'help-csrf'}]);
});
for(const outcome of ['expired','processing','paid','needs_review'])test(`${outcome} retains a useful Matter review path without another payment`,async({page})=>{
 const {state,panel}=await fixture(page);Object.assign(state.checkout,{state:outcome,canResume:false});await inspect(panel);await expect(panel.getByRole('button',{name:'Continue with Stripe',exact:true})).toHaveCount(0);await expect(panel.getByRole('button',{name:'Review payment details',exact:true})).toHaveCount(0);expect(state.posts).toEqual([]);
 await panel.getByRole('link',{name:'Request a payment review',exact:true}).click();await expect(page).toHaveURL(new RegExp(`/help\\?caseId=${MATTER}$`));await expect(page.getByRole('link',{name:'Litigation review',exact:true})).toBeVisible();expect(state.posts).toEqual([]);
});
test('unavailable refresh clears the earlier resume control and amounts',async({page})=>{
 const {state,panel}=await fixture(page);await inspect(panel);state.status=502;await panel.getByRole('button',{name:'Refresh payment status',exact:true}).click();await expect(panel).toContainText('Funding details couldn’t load');await expect(panel.getByRole('button',{name:'Continue with Stripe',exact:true})).toHaveCount(0);await expect(panel.getByText('$488.00',{exact:true})).toHaveCount(0);expect(state.posts).toEqual([]);
 state.status=200;await panel.getByRole('button',{name:'Refresh funding details',exact:true}).click();await inspect(panel);await expect(panel.getByRole('button',{name:'Continue with Stripe',exact:true})).toBeVisible();
});
test('stopping a review discards late results without resuming Checkout',async({page})=>{
 const {state,panel}=await fixture(page);let release;const gate=new Promise(resolve=>release=resolve);state.hold=async route=>{await gate;await route.fulfill({contentType:'application/json',body:JSON.stringify(state.checkout)}).catch(()=>{});};
 await panel.getByRole('button',{name:'Review original Checkout',exact:true}).click();await expect.poll(()=>state.reads.length).toBe(1);await panel.getByRole('button',{name:'Stop waiting for payment',exact:true}).click();await expect(panel).toHaveAttribute('data-state','error');release();state.hold=null;await expect(panel.getByRole('button',{name:'Continue with Stripe',exact:true})).toHaveCount(0);expect(state.posts).toEqual([]);
 await panel.getByRole('button',{name:'Refresh funding details',exact:true}).click();await inspect(panel);
});
test('account replacement prevents the resume POST and clears private content',async({page})=>{
 const {state,panel}=await fixture(page);await inspect(panel);state.account.user={...state.account.user,id:'2'.repeat(24),_id:'2'.repeat(24)};await panel.getByRole('button',{name:'Continue with Stripe',exact:true}).click();await expect(panel).toHaveCount(0);expect(state.posts).toEqual([]);
});
test('a changed Matter or unsafe resume destination never leaves the workspace',async({page})=>{
 const {state,panel}=await fixture(page);await inspect(panel);state.url='https://checkout.stripe.com.evil.test/c/pay/cs_test_original';await panel.getByRole('button',{name:'Continue with Stripe',exact:true}).click();await expect(panel).toHaveAttribute('data-state','error');await expect(page).toHaveURL(new RegExp(`/matters/${MATTER}/financials$`));expect(state.posts).toHaveLength(1);
 await panel.getByRole('button',{name:'Refresh funding details',exact:true}).click();state.checkout.fundingRevision='d'.repeat(64);await panel.getByRole('button',{name:'Review original Checkout',exact:true}).click();await expect(panel).toHaveAttribute('data-state','error');await expect(panel.getByRole('button',{name:'Continue with Stripe',exact:true})).toHaveCount(0);
});
for(const theme of ['light','dark'])test(`${theme} Checkout remains readable at mobile, desktop and larger text`,async({page},testInfo)=>{
 const {state,panel}=await fixture(page,{theme});await inspect(panel);
 for(const width of [320,390,1440]){
  await page.setViewportSize({width,height:1000});await page.addStyleTag({content:':root{font-size:20px !important}'});await panel.scrollIntoViewIfNeeded();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);expect((await new AxeBuilder({page}).include('[data-workspace-funding]').withTags(['wcag2a','wcag2aa','wcag21aa']).analyze()).violations).toEqual([]);
  for(const control of await panel.getByRole('button').all()){if(await control.isVisible()){const box=await control.boundingBox();expect(box.height).toBeGreaterThanOrEqual(44);}}
  await panel.screenshot({path:testInfo.outputPath(`${theme}-${width}.png`)});
 }
 expect(await page.evaluate(()=>JSON.stringify({local:localStorage,session:sessionStorage})+document.documentElement.outerHTML)).not.toContain('PRIVATE');expect(state.posts).toEqual([]);
});

test('background refresh preserves the reviewed Checkout and focus until the retained source changes',async({page})=>{
 const {state,panel}=await fixture(page);await inspect(panel);const refresh=panel.getByRole('button',{name:'Refresh payment status',exact:true});await refresh.focus();await panel.evaluate(node=>node.sync());await expect(refresh).toBeVisible();await expect(refresh).toBeFocused();expect(state.reads).toHaveLength(1);
 state.funding.revision='e'.repeat(64);await panel.evaluate(node=>node.sync());await expect(panel.getByRole('button',{name:'Review original Checkout',exact:true})).toBeVisible();await expect(panel.getByRole('button',{name:'Continue with Stripe',exact:true})).toHaveCount(0);expect(state.posts).toEqual([]);
});
