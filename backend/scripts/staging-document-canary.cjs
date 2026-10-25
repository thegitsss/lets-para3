'use strict';
// Default is plan-only. Execute only after owner approval; creates synthetic objects in the exact proposed bucket.
const assert=require('node:assert/strict'),crypto=require('node:crypto');
const {ACCOUNT,REGION,BUCKET,buildStagingDocumentStorage}=require('../infra/stagingDocumentStorage');
const sdk=require('@aws-sdk/client-s3');
const {getSignedUrl}=require('@aws-sdk/s3-request-presigner');
const {classifyMalwareScanResult}=require('../utils/fileSecurity');
const hash=value=>crypto.createHash('sha256').update(value).digest('hex');
function validate(env){
 assert.equal(env.LPC_DEPLOYMENT_ENV,'staging');assert.equal(env.S3_BUCKET,BUCKET);assert.equal(env.S3_REGION,REGION);assert.equal(env.S3_EXPECTED_BUCKET_OWNER,ACCOUNT);
 assert.equal(env.REQUIRE_STORAGE_KMS,'true');assert.equal(env.S3_MALWARE_SCAN_REQUIRED,'true');
 assert.equal(env.STAGING_STORAGE_TARGET_SHA256,hash(BUCKET));assert.equal(env.PRODUCTION_STORAGE_TARGET_SHA256,hash('paraconnect-uploads'));
 assert(!env.S3_LEGACY_UPLOAD_MANIFEST&&!env.S3_LEGACY_UPLOAD_MANIFEST_SHA256,'Staging cannot inherit legacy scan exceptions');
 assert(new RegExp(`^arn:aws:kms:${REGION}:${ACCOUNT}:key/[a-f0-9-]{36}$`).test(env.S3_KMS_KEY_ID||''),'Exact new staging key ARN required');
 assert(env.S3_ACCESS_KEY&&env.S3_SECRET_KEY,'Staging application credentials required');
}
async function execute(env){
 validate(env);
 const client=new sdk.S3Client({region:REGION,credentials:{accessKeyId:env.S3_ACCESS_KEY,secretAccessKey:env.S3_SECRET_KEY,...(env.S3_SESSION_TOKEN?{sessionToken:env.S3_SESSION_TOKEN}:{})},maxAttempts:1});
 const report={environment:'staging',bucket:BUCKET,syntheticOnly:true,productionMutations:0,passed:[],objectVersions:[],maximumObjects:5,maximumUploadedBytes:65536,maximumTagPolls:120};
 const owner={Bucket:BUCKET,ExpectedBucketOwner:ACCOUNT},prefix=`cases/${crypto.randomBytes(12).toString('hex')}/documents/scan-required-canary-`,key=prefix+'clean.pdf';
 report.objectPrefix=prefix;
 let written=0,bytes=0;
 const send=c=>client.send(c,{abortSignal:AbortSignal.timeout(20000)});
 const putInput=(Key,Body,extra={})=>({...owner,Key,Body,ContentType:'application/pdf',ServerSideEncryption:'aws:kms',SSEKMSKeyId:env.S3_KMS_KEY_ID,...extra});
 async function write(input){assert(++written<=5);bytes+=input.Body.length;assert(bytes<=65536);return send(new sdk.PutObjectCommand(input));}
 async function refused(action,label){try{await action();}catch(e){if(e.$metadata?.httpStatusCode!==403){const diagnostic=new Error('ProviderDenialMismatch');diagnostic.name='ProviderDenialMismatch';diagnostic.check=label;diagnostic.providerStatus=e.$metadata?.httpStatusCode;diagnostic.providerCode=e.name;throw diagnostic;}report.passed.push(label);return;}const unexpected=new Error('ProviderUnexpectedSuccess');unexpected.check=label;throw unexpected;}
 async function tags(Key,VersionId){const r=await send(new sdk.GetObjectTaggingCommand({...owner,Key,VersionId}));return (r.TagSet||[]).find(t=>t.Key==='GuardDutyMalwareScanStatus')?.Value;}
 async function wait(Key,VersionId){for(let i=0;i<60;i++){const value=await tags(Key,VersionId);if(value&&value!=='PENDING')return value;await new Promise(r=>setTimeout(r,2000));}throw Error('ScanUnavailable: bounded 120-second wait expired; file remains quarantined');}
 try{
  const encryption=await send(new sdk.GetBucketEncryptionCommand(owner));
  const defaults=encryption.ServerSideEncryptionConfiguration.Rules[0].ApplyServerSideEncryptionByDefault;
  assert.equal(defaults.SSEAlgorithm,'aws:kms');assert.equal(defaults.KMSMasterKeyID,env.S3_KMS_KEY_ID);report.passed.push('bucket default exact customer-managed KMS');
  const body=Buffer.from('%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF');
  const uploaded=await write(putInput(key,body));assert(uploaded.VersionId&&uploaded.VersionId!=='null');report.objectVersions.push({key,versionId:uploaded.VersionId});
  assert.equal(uploaded.ServerSideEncryption,'aws:kms');assert.equal(uploaded.SSEKMSKeyId,env.S3_KMS_KEY_ID);report.passed.push('encrypted versioned upload');
  await refused(()=>send(new sdk.PutObjectTaggingCommand({...owner,Key:key,VersionId:uploaded.VersionId,Tagging:{TagSet:[{Key:'GuardDutyMalwareScanStatus',Value:'NO_THREATS_FOUND'}]}})),'app cannot forge scan result');
  await refused(()=>write(putInput(prefix+'forged.pdf',body,{Tagging:'GuardDutyMalwareScanStatus=NO_THREATS_FOUND'})),'upload cannot forge clean tag');
  await refused(()=>write(putInput(prefix+'wrong-encryption.pdf',body,{ServerSideEncryption:'AES256',SSEKMSKeyId:undefined})),'wrong encryption rejected');
  try{await write(putInput(prefix+'wrong-key.pdf',body,{SSEKMSKeyId:`arn:aws:kms:${REGION}:${ACCOUNT}:key/00000000-0000-0000-0000-000000000000`}));throw Error('WrongKeyUploadUnexpectedSuccess');}catch(error){if(error.$metadata?.httpStatusCode===403)report.passed.push('wrong KMS key rejected by authorization');else if(error.$metadata?.httpStatusCode===400&&error.name==='KMS.NotFoundException')report.passed.push('nonexistent KMS key rejected by provider validation');else throw error;}
  const initial=await tags(key,uploaded.VersionId);
  if(classifyMalwareScanResult(initial,{required:true}).safe)report.pendingRead='not observed: scanner completed before first check; pending provider denial still unverified';
  else{await refused(()=>send(new sdk.GetObjectCommand({...owner,Key:key,VersionId:uploaded.VersionId})),'pending version unreadable');report.pendingRead='verified';}
  assert.equal(await wait(key,uploaded.VersionId),'NO_THREATS_FOUND');report.passed.push('GuardDuty clean result applied');
  const head=await send(new sdk.HeadObjectCommand({...owner,Key:key,VersionId:uploaded.VersionId}));assert.equal(head.SSEKMSKeyId,env.S3_KMS_KEY_ID);report.passed.push('HEAD confirms exact KMS key');
  const clean=await send(new sdk.GetObjectCommand({...owner,Key:key,VersionId:uploaded.VersionId}));assert.deepEqual(Buffer.from(await clean.Body.transformToByteArray()),body);report.passed.push('clean version bytes readable');
  const unsigned=await fetch(`https://${BUCKET}.s3.${REGION}.amazonaws.com/${key}`,{signal:AbortSignal.timeout(20000)});assert.equal(unsigned.status,403);report.passed.push('anonymous read denied');
  // EICAR is a harmless standard anti-malware test pattern, not executable malware.
  const eicar=Buffer.from('X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*');
  const infectedKey=prefix+'eicar.txt',infected=await write(putInput(infectedKey,eicar,{ContentType:'text/plain'}));report.objectVersions.push({key:infectedKey,versionId:infected.VersionId});
  assert.equal(await wait(infectedKey,infected.VersionId),'THREATS_FOUND');
  await refused(()=>send(new sdk.GetObjectCommand({...owner,Key:infectedKey,VersionId:infected.VersionId})),'infected version unreadable');
  const url=await getSignedUrl(client,new sdk.GetObjectCommand({...owner,Key:infectedKey,VersionId:infected.VersionId}),{expiresIn:60});
  const denied=await fetch(url,{signal:AbortSignal.timeout(20000)});assert.equal(denied.status,403);report.passed.push('signed URL cannot bypass infected quarantine');
  report.status=report.pendingRead==='verified'?'provider-canary-passed':'partial-pending-read-not-observed';
  report.remaining=['Hosted application upload/attach/preview/delete/export and role permissions','Provider failure, skipped scans, failed tagging and recovery drill','Production adoption approval and separate verification'];
  return report;
 }catch(error){error.canaryReport=report;throw error;}finally{client.destroy();}
}
async function main(){if(!process.argv.includes('--execute-approved')){console.log(JSON.stringify({mode:'plan-only',createsResources:false,uploadsObjects:false,bucket:BUCKET,templateResources:Object.keys(buildStagingDocumentStorage().Resources),approvalRequired:true}));return;}
 const report=await execute(process.env);console.log(JSON.stringify(report,null,2));if(report.status!=='provider-canary-passed')process.exitCode=1;}
if(require.main===module)main().catch(error=>{console.error(JSON.stringify({status:'failed-closed',error:error.name,code:error.code||null,credentialsWithheld:true}));process.exitCode=1;});
module.exports={validate,execute};
