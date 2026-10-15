'use strict';
const fs=require('node:fs'),path=require('node:path'),yaml=require('yaml');
const {execute,validate}=require('./staging-document-canary.cjs');
const {cleanupCanaryVersions}=require('./lib/stagingCanaryCleanup');
const sdk=require('@aws-sdk/client-s3');
const directory='outputs/document-security-20261013';
async function main(){
 const config=yaml.parse(fs.readFileSync(path.join(process.env.HOME,'.render/cli.yaml'),'utf8'));
 const base='https://api.render.com/v1/env-groups/evg-db6irdvf3r2c73cgdas0';
 const headers={Authorization:'Bearer '+config.api.key,'Content-Type':'application/json'};
 async function request(url,options={}){const r=await fetch(url,{...options,headers,signal:AbortSignal.timeout(20000)});if(!r.ok)throw Error('RenderManagementRequestFailed');return r.json();}
 const group=await request(base);if(group.name!=='LPC staging secrets')throw Error('UnexpectedStagingGroup');
 if((group.serviceLinks||[]).length||(group.services||[]).length)throw Error('StagingSecretGroupAlreadyLinked');
 if(process.argv.includes('--resume')){
  for(const name of ['S3_ACCESS_KEY','S3_SECRET_KEY','S3_BUCKET','S3_REGION','S3_KMS_KEY_ID','S3_EXPECTED_BUCKET_OWNER','REQUIRE_STORAGE_KMS','S3_MALWARE_SCAN_REQUIRED','STAGING_STORAGE_TARGET_SHA256','PRODUCTION_STORAGE_TARGET_SHA256']){
   const v=await request(base+'/env-vars/'+name);process.env[name]=v.value||v.envVar?.value;
  }
  process.env.LPC_DEPLOYMENT_ENV='staging';
 }
 const names=['S3_ACCESS_KEY','S3_SECRET_KEY','S3_BUCKET','S3_REGION','S3_KMS_KEY_ID','S3_EXPECTED_BUCKET_OWNER','REQUIRE_STORAGE_KMS','S3_MALWARE_SCAN_REQUIRED','STAGING_STORAGE_TARGET_SHA256','PRODUCTION_STORAGE_TARGET_SHA256'];
 validate(process.env);
 for(const name of names)await request(base+'/env-vars/'+name,{method:'PUT',body:JSON.stringify({value:process.env[name]})});
 fs.writeFileSync(directory+'/staging-credential-storage.json',JSON.stringify({group:'LPC staging secrets',id:'evg-db6irdvf3r2c73cgdas0',storedVariableNames:names,credentialsPrinted:false,linkedServices:0,deployments:0},null,2)+'\n');
 let report;
 try{report=await execute(process.env);}catch(error){report={...error.canaryReport,status:'provider-verification-failed',check:error.check||null,providerCode:error.providerCode||null,providerStatus:error.providerStatus||null,errorType:error.name,errorCode:error.Code||error.code||null,httpStatus:error.$metadata?.httpStatusCode||null,location:error.stack?.split('\n').find(line=>line.includes('staging-document-canary.cjs'))?.trim(),assertActual:typeof error.actual==='string'&&error.actual.length<100?error.actual:null,assertExpected:typeof error.expected==='string'&&error.expected.length<100?error.expected:null,credentialsPrinted:false};}
 fs.writeFileSync(directory+'/aws-provider-canary.json',JSON.stringify(report,null,2)+'\n');
 console.log(JSON.stringify(report));
 const client=new sdk.S3Client({region:process.env.S3_REGION,credentials:{accessKeyId:process.env.S3_ACCESS_KEY,secretAccessKey:process.env.S3_SECRET_KEY},maxAttempts:1});
 try{
  const cleanup={...await cleanupCanaryVersions(client,report),applicationCredentialsStoredSecurely:true};
  fs.writeFileSync(directory+'/aws-object-cleanup.json',JSON.stringify(cleanup,null,2)+'\n');console.log(JSON.stringify(cleanup));
 }finally{client.destroy();}
 if(report.status!=='provider-canary-passed')process.exitCode=1;
}
main().catch(e=>{console.log(JSON.stringify({status:'live-helper-stopped',errorType:e.name,errorCode:e.code||null,credentialsPrinted:false}));process.exitCode=1;});
