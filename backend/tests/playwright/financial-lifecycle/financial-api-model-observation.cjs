'use strict';
// Exactly the direct Mongo payment-operation guard packet uses this fixture.
// No browser context or rendered/native-lifetime claim applies to these checks.
const {test:base,expect}=require('playwright/test');
const fs=require('node:fs/promises');
const original=require('./financial-strict-observation.cjs');
let active;
async function capture(kind){if(active)active.stages.push({index:active.stages.length,kind,at:new Date().toISOString(),models:await original.snapshot()});}
async function start(...args){const server=await original.start(...args),reset=server.reset.bind(server);server.reset=async(...values)=>{await reset(...values);await capture('after-original-reset-before-actors');};return server;}
const test=base.extend({financialStrictObservation:[async({},use,info)=>{
 const record={title:info.title,engine:info.project.name,isApiModelContract:true,nativeContextObservationApplicable:false,contexts:[],allContextsClosed:null,stages:[],captureErrors:[],pageErrors:[],closeErrors:[],boundary:'Run-owned managed Mongo database and all100 actual models. Direct payment-operation helper assertions; no browser context, native-lifetime, UI, real provider or external-money proof.'};
 active=record;
 try{await use(record);}finally{
  try{await capture('after-api-model-assertions');}catch(error){record.captureErrors.push({name:error.name,message:error.message,stack:error.stack});}
  active=null;const file=info.outputPath('financial-strict-evidence.json');await fs.writeFile(file,JSON.stringify(record,null,2));await info.attach('financial-strict-evidence.json',{path:file,contentType:'application/json'});
  expect(record.captureErrors).toEqual([]);expect(record.contexts).toEqual([]);expect(record.nativeContextObservationApplicable).toBe(false);
  expect(record.stages[0]?.kind).toBe('after-original-reset-before-actors');expect(record.stages.at(-1)?.kind).toBe('after-api-model-assertions');expect(record.stages.every(stage=>Object.keys(stage.models).length===100)).toBe(true);
 }
},{auto:true}]});
module.exports={test,expect,start,snapshot:original.snapshot};
