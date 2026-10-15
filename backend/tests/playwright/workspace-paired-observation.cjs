"use strict";
const {test:base,expect}=require('playwright/test');
const fs=require('node:fs/promises');
async function snapshot(){
 const mongoose=require('mongoose'),result={};
 for(const name of Object.keys(mongoose.models).sort()){
  const model=mongoose.models[name];
  const projection=name==='User'?{role:1,status:1,disabled:1,deleted:1,authVersion:1,notificationPrefs:1,notifications:1,firstName:1,lastName:1,email:1,pendingEmail:1,state:1,location:1,bio:1,about:1,yearsExperience:1,practiceAreas:1,specialties:1,skills:1,stateExperience:1,jurisdictions:1,linkedInURL:1,education:1,languages:1,preferences:1,profileImage:1,profilePhotoStatus:1}:name==='AuthSession'?{userId:1,expiresAt:1,revokedAt:1,revokedReason:1}:null;
  result[name]=await model.collection.find({},projection?{projection}:{}).sort({_id:1}).toArray();
 }
 return result;
}
function createContextObservation(title, engine) {
  const observation = { schemaVersion: 2, title, engine, pageErrors: [], contexts: [] };
  const seen = new WeakMap();
  function attach(context, owner) {
    if (seen.has(context)) return seen.get(context);
    const record = { id: observation.contexts.length + 1, owner, pagesObserved: 0, closeEventObserved: false, closeCalls: [] };
    observation.contexts.push(record); seen.set(context, record);
    const pages = new WeakSet();
    const observe = page => {
      if (pages.has(page)) return;
      pages.add(page); record.pagesObserved += 1;
      page.on('pageerror', error => observation.pageErrors.push({ contextId: record.id, message: error.message, url: page.url() }));
    };
    context.pages().forEach(observe); context.on('page', observe);
    context.on('close', () => { record.closeEventObserved = true; });
    const originalClose = context.close;
    context.close = async function (...args) {
      const call = { invocation: record.closeCalls.length + 1, requestedAt: new Date().toISOString(), completedAt: null, error: null };
      record.closeCalls.push(call);
      try {
        const value = await originalClose.apply(this, args);
        call.completedAt = new Date().toISOString();
        return value;
      } catch (error) {
        call.error = { name: error.name, message: error.message };
        throw error;
      }
    };
    return record;
  }
  function finish() {
    observation.openContextIds = observation.contexts.filter(record => !record.closeEventObserved).map(record => record.id);
    observation.incompleteCloseContextIds = observation.contexts.filter(record => !record.closeCalls.length || record.closeCalls.some(call => !call.completedAt || call.error)).map(record => record.id);
    observation.contextCloseComplete = observation.openContextIds.length === 0 && observation.incompleteCloseContextIds.length === 0;
    observation.finishedAt = new Date().toISOString();
    return observation;
  }
  return { observation, attach, finish };
}

const test=base.extend({pairedPageObservation:[async({browser},use,info)=>{
 const observation={title:info.title,engine:info.project.name,captureScope:'automatic-per-test-through-all-context-close',pageErrors:[],consoleErrors:[],contexts:[],baselineStage:'before-first-browser-context-after-first-actor-create'};
 const contexts=[],originalCreate=browser.newContext;
 let before=null,artifactFailure=null;
 const observe=page=>{page.on('pageerror',error=>observation.pageErrors.push({message:error.message,url:page.url()}));page.on('console',message=>{if(message.type()==='error')observation.consoleErrors.push({text:message.text(),url:page.url(),location:message.location()});});};
 browser.newContext=async function(...args){
  if(!before)before=await snapshot();
  const context=await originalCreate.apply(this,args),record={index:contexts.length,closed:false};
  contexts.push(context);observation.contexts.push(record);context.on('close',()=>{record.closed=true;});context.pages().forEach(observe);context.on('page',observe);return context;
 };
 try{await use(observation);}finally{
  browser.newContext=originalCreate;
  for(const context of contexts)try{await context.close();}catch(error){artifactFailure=error.message;}
  observation.allContextsClosed=observation.contexts.length>0&&observation.contexts.every(c=>c.closed);
  observation.artifactFailure=artifactFailure;
  await fs.writeFile(info.outputPath('paired-page-observation.json'),JSON.stringify(observation,null,2));
  await fs.writeFile(info.outputPath('paired-actual-records.json'),JSON.stringify({title:info.title,engine:info.project.name,baselineStage:observation.baselineStage,before,after:await snapshot(),allContextsClosed:observation.allContextsClosed,artifactFailure},null,2));
  expect(artifactFailure).toBeNull();expect(observation.allContextsClosed).toBe(true);expect(observation.pageErrors).toEqual([]);
 }
},{auto:true}]});
module.exports={test,expect,createContextObservation};
