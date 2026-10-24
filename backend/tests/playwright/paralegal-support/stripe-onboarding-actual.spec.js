'use strict';
const {test,expect}=require('../workspace-paired-observation.cjs');
const fs=require('node:fs/promises');const start=require('../../helpers/financialLifecycleBrowserServer');let server;
test.beforeAll(async()=>{test.setTimeout(240000);server=await start({port:5879});});
test.beforeEach(async()=>server.reset());test.afterAll(async()=>server?.close());
for(const width of [1440,390])test(`actual V2 Stripe setup retains its account after failure and verifies the return ${width}`,async({browser},info)=>{
 test.setTimeout(180000);const actor=await server.createUser('paralegal'),User=require('../../../models/User'),stripe=server.provider.stripe;
 await User.updateOne({_id:actor.id},{$unset:{stripeAccountId:1},$set:{stripeOnboarded:false,stripeChargesEnabled:false,stripePayoutsEnabled:false}});
 let failLink=true,completed=false;const accountId='acct_synthetic_'+actor.id,creates=[],links=[];
 stripe.accounts.create=async(params,options)=>{creates.push({params,options});return {id:accountId,object:'account',livemode:false};};
 stripe.accounts.retrieve=async(id)=>{expect(id).toBe(accountId);return {id,object:'account',livemode:false,details_submitted:completed,charges_enabled:completed,payouts_enabled:completed,requirements:{currently_due:completed?[]:['external_account'],past_due:[],disabled_reason:null},capabilities:{transfers:completed?'active':'inactive'}};};
 stripe.accountLinks.create=async(params)=>{links.push(params);if(failLink)throw Error('Synthetic temporary link failure');return {url:'https://connect.stripe.com/setup/synthetic-'+actor.id};};
 const context=await browser.newContext({viewport:{width,height:1000}});await context.addCookies([actor.cookie]);const page=await context.newPage();
 await context.route('**/*',async route=>{const u=new URL(route.request().url());if(u.origin===server.origin)return route.continue();if(u.href==='https://connect.stripe.com/setup/synthetic-'+actor.id){const link=links.at(-1);return route.fulfill({status:200,contentType:'text/html',body:'<!doctype html><title>Synthetic Stripe boundary</title><a href="'+link.return_url+'">Return to LPC</a>'});}return route.abort();});
 const open=async()=>{await page.goto(server.origin+'/paralegal-v2.html#/settings?tab=security');await expect(page.getByRole('heading',{name:'Stripe payouts',exact:true})).toBeVisible();};
 try{
  await open();await expect(page.getByText('Action required',{exact:true})).toBeVisible();await page.getByRole('button',{name:'Connect Stripe',exact:true}).click();await expect(page.getByRole('button',{name:'Connect Stripe',exact:true})).toBeEnabled();await expect(page.locator('body')).toContainText('Unable to start Stripe onboarding');
  expect(creates).toHaveLength(1);expect(creates[0].params).toMatchObject({type:'express',metadata:{userId:actor.id}});expect(creates[0].options.idempotencyKey).toEqual(expect.any(String));expect((await User.findById(actor.id).lean()).stripeAccountId).toBe(accountId);expect(links).toHaveLength(1);
  failLink=false;await page.getByRole('button',{name:'Connect Stripe',exact:true}).click();await expect(page).toHaveURL('https://connect.stripe.com/setup/synthetic-'+actor.id);expect(creates).toHaveLength(1);expect(links).toHaveLength(2);expect(links[1]).toMatchObject({account:accountId,type:'account_onboarding'});expect(new URL(links[1].return_url).origin).toBe(server.origin);expect(new URL(links[1].refresh_url).origin).toBe(server.origin);
  completed=true;await page.getByRole('link',{name:'Return to LPC'}).click();await expect(page).toHaveURL(new RegExp('^'+server.origin.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'/'));await open();await expect(page.getByText('Payout setup ready',{exact:true})).toBeVisible();const saved=await User.findById(actor.id).lean();expect(saved).toMatchObject({stripeAccountId:accountId,stripeOnboarded:true,stripePayoutsEnabled:true});expect(creates).toHaveLength(1);
  await fs.writeFile(info.outputPath('stripe-onboarding-boundary.json'),JSON.stringify({actorId:actor.id,creates,links,actualSavedAccount:accountId,verifiedReturnedReadiness:true,externalStripeSynthetic:true,bankUiAndRealPayoutClaimed:false},null,2));await page.screenshot({path:info.outputPath('stripe-return-ready.png')});
 }finally{await context.close();}
});
