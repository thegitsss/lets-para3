'use strict';
// Native client projection contracts, with actual isolated managed sign-in and
// mounted publication routes. The original controlled DTOs are not money proof.
const {test:base,expect,start}=require('./financial-strict-observation.cjs');
let server;
const streams=new WeakMap();
const test=base.extend({
 projectionServer:[async({},use)=>{server=await start({port:0});try{await use(server);}finally{await server.close();}},{scope:'worker',timeout:180000}],
 baseURL:async({projectionServer},use)=>use(projectionServer.origin),
 projectionSession:[async({browser,projectionServer,financialStrictObservation},use,info)=>{
  await projectionServer.reset();
  const actor=await projectionServer.createUser('attorney'),User=require('../../../models/User');
  await User.updateOne({_id:actor.id},{$set:{profileImage:'','onboarding.attorneyTourCompleted':true}});
  const user=await User.findById(actor.id).lean();
  const login=await browser.newContext({baseURL:projectionServer.origin,storageState:{cookies:[],origins:[]}});
  let storage;
  try{
   await login.route('**/*',route=>new URL(route.request().url()).origin===projectionServer.origin?route.continue():route.abort('blockedbyclient'));
   const page=await login.newPage();await page.goto('/login.html',{waitUntil:'domcontentloaded'});await page.locator('#email').fill(user.email);await page.locator('#password').fill('Private synthetic lifecycle password!');await page.getByRole('button',{name:'Sign in',exact:true}).click();await expect(page).toHaveURL(/\/dashboard-attorney\.html(?:[?#].*)?$/);
   const me=await login.request.get('/api/auth/me');expect(me.status()).toBe(200);expect(String((await me.json()).user.id)).toBe(actor.id);storage=await login.storageState();
  }finally{await login.close();}
  financialStrictObservation.projectionContractBoundary={actorId:actor.id,actualManagedPasswordSignIn:true,moneyWritesClaimed:false,originalControlledDtoContracts:true,sourceFile:info.file};
  await use({actor,storage});
 },{auto:true}],
 storageState:async({projectionSession},use)=>use(projectionSession.storage),
 _nativeProjectionContext:[async({context,projectionServer},use)=>{
  await context.route('**/*',route=>new URL(route.request().url()).origin===projectionServer.origin?route.continue():route.abort('blockedbyclient'));
  const observe=page=>{const ids=new Set();streams.set(page,ids);page.on('response',response=>{const u=new URL(response.url());const match=u.pathname.match(/^\/api\/cases\/([a-f0-9]{24})\/stream$/);if(match&&response.status()===200)ids.add(match[1]);});};
  context.pages().forEach(observe);context.on('page',observe);await use();
 },{auto:true}]
});
async function publishOwnedProjection(page){
 const match=new URL(page.url()).hash.match(/\/matters\/([a-f0-9]{24})\//);if(!match)throw Error('Native projection event requires the current owned Matter route');
 const caseId=match[1];await expect.poll(()=>streams.get(page)?.has(caseId)===true).toBe(true);
 require('../../../utils/caseEvents').publishCaseEvent(caseId,'projection',{at:new Date().toISOString()});
}
module.exports={test,expect,publishOwnedProjection};
