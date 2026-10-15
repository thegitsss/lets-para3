'use strict';
const {test:base,expect}=require('playwright/test');
const fs=require('node:fs/promises'),crypto=require('node:crypto');
const originalStart=require('../../helpers/financialLifecycleBrowserServer');
let server,active,starting=false;

async function snapshot(){
 const mongoose=require('mongoose');
 if(!server||mongoose.connection.readyState!==1||mongoose.connection.name!==server.ownedDatabaseName)throw Error('Financial capture requires the owned connected database');
 const names=Object.keys(mongoose.models).sort(),models={};
 if(names.length!==100)throw Error(`Expected the current100 model inventory, found${names.length}`);
 for(const name of names)models[name]=await mongoose.models[name].collection.find({}).sort({_id:1}).toArray();
 return models;
}
async function stage(kind,detail={}){
 if(!active)return;
 const records=await snapshot();
 active.stages.push({index:active.stages.length,kind,at:new Date().toISOString(),...detail,models:records});
}
async function start(...args){
 if(server||starting)throw Error('One owned financial server is required per suite');
 starting=true;
 try{server=await originalStart(...args);}finally{starting=false;}
 const ownedServer=server,close=ownedServer.close.bind(ownedServer);
 ownedServer.close=async(...values)=>{
  const result=await close(...values);
  if(server===ownedServer)server=undefined;
  return result;
 };
 const reset=server.reset.bind(server),inspect=server.inspect.bind(server),createUser=server.createUser.bind(server);
 server.reset=async(...values)=>{await reset(...values);if(active){active.lastFinancial.clear();await stage('after-original-reset-before-actors');}};
 server.createUser=async(...values)=>{const value=await createUser(...values);if(active)active.actors.push({role:values[0],id:value.id});return value;};
 server.inspect=async(...values)=>{
  const result=await inspect(...values);
  if(active){const key=String(values[0]),hash=crypto.createHash('sha256').update(JSON.stringify(result)).digest('hex');
   if(active.lastFinancial.get(key)!==hash){active.lastFinancial.set(key,hash);await stage('original-actual-financial-inspection',{caseId:key,financialSha256:hash});}
  }
  return result;
 };
 return server;
}
const test=base.extend({financialStrictObservation:[async({browser},use,info)=>{
 const contexts=[],original=browser.newContext;
 const record={title:info.title,engine:info.project.name,modelInventoryExpected:100,actors:[],stages:[],pageErrors:[],consoleErrors:[],requestFailures:[],contexts:[],lastFinancial:new Map()};
 active=record;
 const observe=page=>{
  page.on('pageerror',error=>record.pageErrors.push({name:error.name,message:error.message,stack:error.stack,url:page.url(),at:Date.now()}));
  page.on('console',message=>{if(message.type()==='error')record.consoleErrors.push({text:message.text(),location:message.location(),url:page.url(),at:Date.now()});});
  page.on('requestfailed',request=>record.requestFailures.push({method:request.method(),url:request.url(),error:request.failure()?.errorText,at:Date.now()}));
 };
 browser.newContext=async function(...args){
  const context=await original.apply(this,args),entry={index:contexts.length,closed:false,pages:0};contexts.push(context);record.contexts.push(entry);
  context.on('close',()=>{entry.closed=true;entry.closedAt=Date.now();});
  context.pages().forEach(page=>{entry.pages++;observe(page);});context.on('page',page=>{entry.pages++;observe(page);});
  return context;
 };
 try{await use(record);}finally{
  browser.newContext=original;
  record.closeErrors=[];
  for(const context of contexts)try{await context.close();}catch(error){record.closeErrors.push({name:error.name,message:error.message});}
  record.allContextsClosed=contexts.length>0&&record.contexts.every(row=>row.closed);
  record.captureErrors=[];
  try{await stage('after-all-actual-contexts-closed');}catch(error){record.captureErrors.push({name:error.name,message:error.message,stack:error.stack});}
  record.syntheticProviderCalls=server?.provider?.calls||[];
  record.serverEvidence=server?.evidence();
  record.syntheticStoredObjectInventory=server?.inspectStoredObjects?.()||[];
  delete record.lastFinancial;active=null;
  const output=info.outputPath('financial-strict-evidence.json');
  await fs.writeFile(output,JSON.stringify(record,null,2),{mode:0o600});
  await info.attach('financial-strict-evidence.json',{path:output,contentType:'application/json'});
  expect(record.closeErrors).toEqual([]);expect(record.captureErrors).toEqual([]);expect(record.allContextsClosed).toBe(true);
  expect(record.stages[0]?.kind).toBe('after-original-reset-before-actors');
  expect(record.stages.at(-1)?.kind).toBe('after-all-actual-contexts-closed');
  expect(record.stages.every(value=>Object.keys(value.models).length===100)).toBe(true);
  expect(record.pageErrors).toEqual([]);
 }
},{auto:true}]});
module.exports={test,expect,start,snapshot};
