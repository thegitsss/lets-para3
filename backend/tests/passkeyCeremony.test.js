const {execFileSync}=require('node:child_process');
const path=require('node:path');
test('native passkey waits complete normally, preserve errors and recover from a stalled browser',()=>{
 const file=path.resolve(__dirname,'../../frontend/assets/scripts/utils/passkey-ceremony.js');
 const script=`
 import fs from 'node:fs';import assert from 'node:assert/strict';
 const {runPasskeyCeremony,runPasskeyRequest,createPasskeyEnrollment}=await import('data:text/javascript;base64,'+fs.readFileSync(${JSON.stringify(file)}).toString('base64'));
 let canceled=0;
 assert.equal(await runPasskeyCeremony(()=>Promise.resolve('credential'),{timeoutMs:50,cancel:()=>canceled++}),'credential');assert.equal(canceled,0);
 const original=new Error('browser failure');await assert.rejects(runPasskeyCeremony(()=>Promise.reject(original),{timeoutMs:50}),error=>error===original);
 await assert.rejects(runPasskeyCeremony(()=>new Promise(()=>{}),{timeoutMs:10,cancel:()=>canceled++}),error=>error.name==='PasskeyTimeoutError'&&/regular Chrome or Safari/.test(error.message));assert.equal(canceled,1);
 await assert.rejects(runPasskeyCeremony(()=>new Promise(()=>{}),{timeoutMs:10,cancel:()=>{throw new Error('abort unavailable')}}),error=>error.name==='PasskeyTimeoutError');
 let aborted=false;await assert.rejects(runPasskeyRequest(signal=>new Promise(()=>{signal.addEventListener('abort',()=>{aborted=true})}),{timeoutMs:10,mutating:true}),error=>error.kind==='uncertain');assert.equal(aborted,true);
 const prepared={challengeId:'isolated-challenge',options:{challenge:'isolated-native-challenge'}};let starts=0,saves=0;
 const flow=createPasskeyEnrollment({begin:async password=>{assert.equal(password,'current password');return prepared},start:options=>{starts++;assert.equal(options,prepared.options);return Promise.resolve({id:'verified-credential'})},save:async value=>{saves++;assert.equal(value.challengeId,prepared.challengeId);return{id:'saved'};}});
 await flow.prepare('current password');assert.equal(flow.phase,'ready');assert.equal(starts,0);const completed=flow.create('Work device');assert.equal(starts,1);await completed;assert.equal(saves,1);assert.equal(flow.phase,'saved');
 let resolveDevice,lateSaves=0;
 const stalled=createPasskeyEnrollment({begin:async()=>prepared,start:()=>new Promise(resolve=>{resolveDevice=resolve}),save:async()=>lateSaves++,cancelNative:()=>canceled++});
 await stalled.prepare('proof');const pending=stalled.create();assert.equal(stalled.phase,'device');assert.equal(stalled.cancel(),true);resolveDevice({id:'late'});await assert.rejects(pending,error=>error.name==='AbortError');assert.equal(lateSaves,0);assert.equal(stalled.phase,'closed');
 let time=0;
 const expired=createPasskeyEnrollment({begin:async()=>prepared,start:()=>{throw new Error('expired setup reached device')},save:async()=>{},now:()=>time});await expired.prepare('proof');time=240001;await assert.rejects(expired.create(),/expired/);assert.equal(expired.phase,'password');
 let failedSaves=0;
 const failed=createPasskeyEnrollment({begin:async()=>prepared,start:async()=>({id:'device'}),save:async()=>{failedSaves++;throw new Error('save failed')}});await failed.prepare('proof');await assert.rejects(failed.create(),/save failed/);assert.equal(failedSaves,1);assert.equal(failed.phase,'password');
 `;
 expect(()=>execFileSync(process.execPath,['--input-type=module','-e',script],{timeout:5000,stdio:'pipe'})).not.toThrow();
});
