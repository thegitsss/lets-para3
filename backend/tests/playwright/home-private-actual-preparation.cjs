const {expect}=require('playwright/test');
async function ensureEligibleMatter(page,caseId,foundationServer){
 const mongoose=require('mongoose');if(mongoose.connection.name!==foundationServer.ownedDatabaseName)throw Error('Unowned eligibility database');
 const me=(await(await page.request.get('/api/auth/me')).json()).user,ownerId=String(me.id||me._id);
 const before=await mongoose.models.Case.findById(caseId).lean();expect(String(before.attorneyId||before.attorney)).toBe(ownerId);
 const person=await foundationServer.createActor('paralegal',{},true);
 const ctx=await page.context().browser().newContext({baseURL:foundationServer.origin});let closed=false;
 try{
  await ctx.addCookies([person.cookie]);
  async function request(client,method,url,data){const csrf=await(await client.get('/api/csrf')).json();const response=await client[method](url,{headers:{'X-CSRF-Token':csrf.csrfToken},...(data?{data}:{} )});expect(response.ok(),await response.text()).toBeTruthy();return response.json();}
  const job=await mongoose.models.Job.findOne({caseId}).lean();expect(job).toBeTruthy();
  await request(ctx.request,'post','/api/jobs/'+job._id+'/apply',{coverLetter:'I can prepare the exhibit index.'});
  await request(page.request,'post','/api/payments/payment-method/default',{paymentMethodId:'pm_browser_card'});
  const review=await request(page.request,'get','/api/cases/'+caseId+'/hiring-review/'+person.id+'?expectedOwnerId='+ownerId);
  await request(page.request,'post','/api/cases/'+caseId+'/hire/'+person.id,{expectedOwnerId:ownerId,reviewedRevision:review.revision});
  const after=await mongoose.models.Case.findById(caseId).lean();expect(String(after.paralegalId||after.paralegal)).toBe(person.id);expect(after.escrowStatus).toBe('funded');expect(after.escrowIntentId).toBeTruthy();
  return {caseId,ownerId,paralegalId:person.id,escrowStatus:after.escrowStatus};
 }finally{await ctx.close();closed=true;expect(closed).toBe(true);}
}

module.exports={ensureEligibleMatter};
