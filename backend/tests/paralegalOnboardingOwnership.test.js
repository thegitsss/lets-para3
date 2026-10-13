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
