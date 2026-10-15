const {test}=require('./shell-fixture');
const {expect}=require('playwright/test');
const {fixture,json,MATTER,workspaceMatter}=require('./fixture');
const {browsePageFixture}=require('../paralegal-support/browse-page-fixture');
test('owner overview shows quiet aggregate only and other sections omit it',async({page},info)=>{
  await fixture(page,'attorney',{hash:`/matters/${MATTER}/overview`,setup:state=>{
    state.matterRespond=route=>json(route,{...workspaceMatter(),postingViews:{uniqueParalegals:12,applications:3}});
  }});
  const overview=page.getByRole('region',{name:'Matter overview',exact:true});
  await expect(overview.getByText('12 paralegals viewed · 3 applications',{exact:true})).toBeVisible();
  await page.screenshot({path:info.outputPath('posting-views.png')});
  await page.getByRole('navigation',{name:'Matter sections'}).getByRole('link',{name:'Work',exact:true}).click();
  await expect(page.getByText('12 paralegals viewed · 3 applications',{exact:true})).toHaveCount(0);
});
test('Browse records detail opens but not list impressions and remains usable if recording fails',async({page})=>{
  let opens=0;
  const item={_id:MATTER,id:MATTER,caseId:MATTER,title:'Trial document preparation',practiceArea:'Contract law',state:'New York',description:'Prepare the supporting documents.',totalAmount:50000,attorneyId:'222222222222222222222222',attorney:{firstName:'Dana',lastName:'Young'},tasks:[],applicationEligibility:{ready:true,allowed:true,blockers:[],facts:{payoutReadiness:{ready:true,blockers:[]}}}};
  await fixture(page,'paralegal',{hash:'/browse',setup:async state=>{
    await page.route('**/api/jobs/open?**',route=>json(route,browsePageFixture([item],new URL(route.request().url()).searchParams,state.user.id)));
    await page.route(`**/api/jobs/${MATTER}/view`,route=>{opens++;return json(route,{error:'Unavailable'},503);});
  }});
  await expect(page.getByText(item.title,{exact:true}).first()).toBeVisible();expect(opens).toBe(0);
  await page.locator(`[data-browse-detail-id="${MATTER}"]`).click();
  await expect(page.getByRole('heading',{name:item.title,exact:true})).toBeVisible();
  await expect.poll(()=>opens).toBe(1);
});
