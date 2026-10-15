'use strict';
const fs=require('node:fs'),path=require('node:path'),yaml=require('yaml'),assert=require('node:assert/strict'),crypto=require('node:crypto'),{execFileSync}=require('node:child_process'),sdk=require('@aws-sdk/client-s3');
const {cleanupPrincipalControlVersions}=require('./lib/stagingCanaryCleanup');
async function main(){
 const config=yaml.parse(fs.readFileSync(path.join(process.env.HOME,'.render/cli.yaml'),'utf8'));
 async function secret(n){const r=await fetch('https://api.render.com/v1/env-groups/evg-db6irdvf3r2c73cgdas0/env-vars/'+n,{headers:{Authorization:'Bearer '+config.api.key},signal:AbortSignal.timeout(20000)});assert(r.ok);const v=await r.json();return v.value||v.envVar?.value;}
 const [accessKeyId,secretAccessKey,keyArn]=await Promise.all(['S3_ACCESS_KEY','S3_SECRET_KEY','S3_KMS_KEY_ID'].map(secret));
 const admin=JSON.parse(execFileSync('/private/tmp/lpc-awscli-runtime-2.36.40/bin/aws',['configure','export-credentials','--profile','lpc-staging-provisioner','--region','us-east-1','--format','process'],{encoding:'utf8',stdio:['ignore','pipe','pipe']}));
 const app=new sdk.S3Client({region:'us-east-1',credentials:{accessKeyId,secretAccessKey},maxAttempts:1}),other=new sdk.S3Client({region:'us-east-1',credentials:{accessKeyId:admin.AccessKeyId,secretAccessKey:admin.SecretAccessKey,sessionToken:admin.SessionToken},maxAttempts:1});
 const owner={Bucket:'lpc-staging-documents-096929701923-us-east-1',ExpectedBucketOwner:'096929701923'},key='cases/'+crypto.randomBytes(12).toString('hex')+'/documents/principal-control.txt',report={bucket:'lpc-staging-documents-096929701923-us-east-1',passed:[],productionMutations:0,syntheticOnly:true,objectKey:key};let version;const versions=[];
 async function denied(action,label){let status,providerCode;try{await action();}catch(e){status=e.$metadata?.httpStatusCode;providerCode=e.name;}if(status!==403){const error=Error('UnexpectedProviderStatus');error.name='UnexpectedProviderStatus';error.check=label;error.providerStatus=status;error.providerCode=providerCode;throw error;}report.passed.push(label);}
 try{
  const alias=await app.send(new sdk.PutObjectCommand({...owner,Key:key,Body:'Synthetic',ServerSideEncryption:'aws:kms',SSEKMSKeyId:'alias/lpc-staging-documents'}));versions.push(alias.VersionId);assert.equal(alias.SSEKMSKeyId,keyArn);report.passed.push('AWS resolves staging alias to exact authorized KMS key');
  const deniedKey='unauthorized-prefix/principal-control-'+crypto.randomBytes(12).toString('hex')+'.txt';
  await denied(async()=>{const unexpected=await app.send(new sdk.PutObjectCommand({...owner,Key:deniedKey,Body:'Synthetic',ServerSideEncryption:'aws:kms',SSEKMSKeyId:keyArn}));report.unexpectedCreatedObjectVersions=[{key:deniedKey,versionId:unexpected.VersionId}];report.manualCleanupRequired=true;},'application cannot upload outside approved prefixes');
  const r=await app.send(new sdk.PutObjectCommand({...owner,Key:key,Body:'Synthetic principal restriction check.',ServerSideEncryption:'aws:kms',SSEKMSKeyId:keyArn}));version=r.VersionId;versions.push(version);
  let clean=false;for(let i=0;i<60;i++){const t=await app.send(new sdk.GetObjectTaggingCommand({...owner,Key:key,VersionId:version}));if(t.TagSet?.some(x=>x.Key==='GuardDutyMalwareScanStatus'&&x.Value==='NO_THREATS_FOUND')){clean=true;break;}await new Promise(r=>setTimeout(r,2000));}assert(clean);
  const readable=await app.send(new sdk.GetObjectCommand({...owner,Key:key,VersionId:version}));await readable.Body.transformToByteArray();report.passed.push('authorized app reads scanned clean version');
  await denied(()=>other.send(new sdk.GetObjectCommand({...owner,Key:key,VersionId:version})),'other authenticated principal denied even for clean object');report.status='passed';
 }finally{try{Object.assign(report,await cleanupPrincipalControlVersions(app,report));fs.writeFileSync('outputs/document-security-20261013/aws-principal-access-controls.json',JSON.stringify(report,null,2)+'\n');}finally{app.destroy();other.destroy();}}
 console.log(JSON.stringify(report));
}
main().catch(e=>{console.log(JSON.stringify({status:'access-control-check-stopped',errorType:e.name,check:e.check,providerStatus:e.providerStatus,providerCode:e.providerCode,localProcessStatus:e.status,localProcessSignal:e.signal,credentialsPrinted:false}));process.exitCode=1;});
