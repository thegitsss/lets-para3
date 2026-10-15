const {test,expect,fixture}=require('../payment-summary/legacy-fixture');
for(const status of ['success','cancel'])test(`original ${status} return preserves Matter context without claiming payment success or failure`,async({page})=>{
 const matter='000000000000000000000001',reads=[];await fixture(page,{setup:async()=>{
  await page.route('**/api/payments/attorney-financial-history?**',route=>{const q=new URL(route.request().url()).searchParams;reads.push(Object.fromEntries(q));return route.fulfill({contentType:'application/json',body:JSON.stringify({ownerId:'1'.repeat(24),revision:'a'.repeat(64),view:'all',q:'',caseId:q.get('caseId'),entries:[],total:0,nextCursor:null,summary:{currencies:[],requiresReview:0,pending:0,undated:0}})});});
 }});
 await page.goto(`/dashboard-attorney.html?payment=${status}&caseId=${matter}#funds`);await expect(page).toHaveURL(new RegExp(`caseId=${matter}#funds$`));await expect(page.getByText('You returned from Checkout. Review the Matter’s current payment status.',{exact:true})).toBeVisible();await expect(page.locator('[data-financial-history]')).toHaveAttribute('data-state','ready');expect(reads.at(-1).caseId).toBe(matter);
 await expect(page.getByText(/No payment was processed|Payment submitted|Payment was not completed/)).toHaveCount(0);await expect(page.locator('#activeEscrowsBody').getByRole('link',{name:'Matter 0001',exact:true})).toHaveAttribute('href',`/attorney-v2.html#/matters/${matter}/financials`);
});
