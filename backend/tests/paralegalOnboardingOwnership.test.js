const {execFileSync}=require('node:child_process');
const {pathToFileURL}=require('node:url');
const path=require('node:path');
const source=pathToFileURL(path.resolve(__dirname,'../../frontend/assets/scripts/paralegal-v2/onboarding-controller.mjs')).href;
const check=code=>{execFileSync(process.execPath,['--input-type=module','--eval',`import assert from 'node:assert/strict';import {createOnboardingController} from ${JSON.stringify(source)};${code}`],{stdio:'pipe'});};
for(const sameAccount of [false,true])test(`late onboarding response cannot change a restarted ${sameAccount?'same':'different'} account`,()=>check(`
 let release;const held=new Promise(resolve=>{release=resolve});let reads=0;const updates=[];
 let identity={id:'a'.repeat(24),onboarding:{paralegalTourCompleted:false,paralegalProfileTourCompleted:false}};
 const controller=createOnboardingController({api:{get:()=>++reads===1?held:Promise.resolve({onboarding:{paralegalTourCompleted:false,paralegalProfileTourCompleted:false}})},getIdentity:()=>identity,updateIdentity:value=>{identity=value;updates.push(value);},getRoute:()=>null});
 const old=controller.start(identity);controller.stop();identity={id:${sameAccount?'"a"':'"b"'}.repeat(24),onboarding:{paralegalTourCompleted:false,paralegalProfileTourCompleted:false}};
 await controller.start(identity);const owner=identity.id;release({onboarding:{paralegalTourCompleted:true,paralegalProfileTourCompleted:true}});await old;
 assert.equal(identity.id,owner);assert.equal(identity.onboarding.paralegalTourCompleted,false);assert.equal(identity.onboarding.paralegalProfileTourCompleted,false);assert.equal(updates.length,1);
`));
test('a failed old onboarding read cannot show an error in the replacement account',()=>check(`
 let reject;const held=new Promise((_resolve,fail)=>{reject=fail});let reads=0,toasts=0;
 let identity={id:'a'.repeat(24)};const controller=createOnboardingController({api:{get:()=>++reads===1?held:Promise.resolve({onboarding:{}})},getIdentity:()=>identity,updateIdentity:value=>{identity=value;},showToast:()=>toasts++,getRoute:()=>null});
 const old=controller.start(identity);controller.stop();identity={id:'b'.repeat(24)};await controller.start(identity);reject(new Error('Synthetic old request failed'));await old;assert.equal(toasts,0);assert.equal(identity.id,'b'.repeat(24));
`));

const lifecycle = `
 const handlers=new Map();
 globalThis.window={addEventListener(type,listener,options){const list=handlers.get(type)||[];list.push({listener,capture:options===true||options?.capture===true});handlers.set(type,list);},dispatchEvent(event){for(const item of [...(handlers.get(event.type)||[])].sort((a,b)=>Number(b.capture)-Number(a.capture)))item.listener(event);}};
 globalThis.document={visibilityState:'visible'};
 const event=(type,properties={})=>window.dispatchEvent({type,isTrusted:true,...properties});
`;
test('native departure aborts the owned onboarding read and trusted interaction restores the same account',()=>check(lifecycle+`
 let reads=0,toasts=0,signal;const updates=[];
 let identity={id:'a'.repeat(24),firstName:'Private current name',onboarding:{paralegalTourCompleted:false,paralegalProfileTourCompleted:false}};
 const controller=createOnboardingController({api:{get:(_path,options)=>{reads++;signal=options.signal;return reads===1?new Promise((_ok,fail)=>signal.addEventListener('abort',()=>fail(new DOMException('Cancelled','AbortError')),{once:true})):Promise.resolve({onboarding:{paralegalTourCompleted:true,paralegalProfileTourCompleted:true}});}},getIdentity:()=>identity,updateIdentity:value=>{identity=value;updates.push(value);},showToast:()=>toasts++,getRoute:()=>null});
 const old=controller.start(identity);event('beforeunload');await old;assert.equal(signal.aborted,true);assert.equal(toasts,0);assert.equal(updates.length,0);assert.equal(identity.firstName,'Private current name');
 await controller.start(identity);assert.equal(reads,1);event('pointerdown',{isTrusted:false});assert.equal(reads,1);event('keydown');await new Promise(resolve=>setTimeout(resolve,0));assert.equal(reads,2);assert.equal(updates.length,1);assert.equal(identity.id,'a'.repeat(24));assert.equal(identity.firstName,'Private current name');assert.equal(identity.onboarding.paralegalTourCompleted,true);
`));
test('a leaving document cannot restart onboarding reads and persisted pageshow reopens the owned read',()=>check(lifecycle+`
 let reads=0;let identity={id:'a'.repeat(24)};
 const controller=createOnboardingController({api:{get:()=>{reads++;return Promise.resolve({onboarding:{}});}},getIdentity:()=>identity,updateIdentity:value=>{identity=value;},getRoute:()=>null});
 await controller.start(identity);event('pagehide');event('pointerdown');await controller.start(identity);assert.equal(reads,1);event('pageshow',{persisted:true});await new Promise(resolve=>setTimeout(resolve,0));assert.equal(reads,2);assert.equal(identity.id,'a'.repeat(24));
`));
test('stopping a suspended onboarding controller permits a fresh owner and rejects the old read',()=>check(lifecycle+`
 let reads=0,signal;const updates=[];let identity={id:'a'.repeat(24)};
 const controller=createOnboardingController({api:{get:(_path,options)=>{reads++;signal=options.signal;return reads===1?new Promise((_ok,fail)=>signal.addEventListener('abort',()=>fail(new DOMException('Cancelled','AbortError')),{once:true})):Promise.resolve({onboarding:{}});}},getIdentity:()=>identity,updateIdentity:value=>{identity=value;updates.push(value);},getRoute:()=>null});
 const old=controller.start(identity);event('beforeunload');controller.stop();identity={id:'b'.repeat(24)};await controller.start(identity);await old;assert.equal(reads,2);assert.equal(updates.length,1);assert.equal(identity.id,'b'.repeat(24));assert.equal(identity.onboarding.paralegalTourCompleted,false);
`));
