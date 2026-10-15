"use strict";
const {test:base,expect}=require('../workspace-paired-observation.cjs');
const start=require('../../helpers/financialLifecycleBrowserServer');
let currentServer;
const test=base.extend({
 hiringConservation:[async({hiringServer},use,info)=>{await use();
 const fs=require('node:fs/promises'),mongoose=require('mongoose'),models=['Case','Job','Application','Payout','PaymentOperation','PlatformIncome'];const records=Object.fromEntries(await Promise.all(models.map(async name=>[name,await mongoose.models[name].collection.find({}).sort({_id:1}).toArray()])));
 const users=await mongoose.models.User.collection.find({},{projection:{_id:1,role:1,status:1,disabled:1,pendingHire:1,stripeCustomerId:1}}).sort({_id:1}).toArray(),evidence=hiringServer.evidence();await fs.writeFile(info.outputPath('hiring-actual-state.json'),JSON.stringify({records,users,requests:evidence.requests,providerCalls:evidence.provider,providerState:hiringServer.provider.state,syntheticProvidersOnly:true},null,2));
 expect(records.Payout).toEqual([]);expect(records.PaymentOperation).toEqual([]);expect(records.PlatformIncome).toEqual([]);expect(records.Case.every(doc=>doc.status==='open'&&!doc.paralegalId&&!doc.hiredParalegalId&&!doc.paymentIntentId&&!doc.stripePaymentIntentId)).toBe(true);expect(evidence.provider.filter(call=>/^(?:paymentIntents\.create|transfers\.create|refunds\.create)$/.test(call.method))).toEqual([]);
},{auto:true}],
 hiringServer:[async({},use)=>{const server=await start({port:0,includeSyntheticDownloads:true,includeSyntheticPersonalDownloads:true,includePublicDirectory:true});currentServer=server;try{await use(server);}finally{await server.close();currentServer=null;}},{scope:'worker',timeout:240000}],
 page:async({browser,hiringServer},use)=>{await hiringServer.reset();const actor=await hiringServer.createUser('attorney'),context=await browser.newContext({baseURL:hiringServer.origin,viewport:{width:1366,height:1000}});await context.addCookies([actor.cookie]);await context.route('**/*',route=>new URL(route.request().url()).origin===hiringServer.origin?route.continue():route.abort());const page=await context.newPage();page.hiringActor=actor;try{await use(page);}finally{await context.close();}},
});
module.exports={test,expect,getServer:()=>currentServer};
