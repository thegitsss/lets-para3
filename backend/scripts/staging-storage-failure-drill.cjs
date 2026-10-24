'use strict';
const fs=require('node:fs'),path=require('node:path'),yaml=require('yaml'),crypto=require('node:crypto'),assert=require('node:assert/strict'),{execFileSync}=require('node:child_process');
const sdk=require('@aws-sdk/client-s3');
const bucket='lpc-staging-documents-096929701923-us-east-1',role='lpc-staging-document-scanner',policyName='lpc-staging-scan-only',dir='outputs/document-security-20261013';
function aws(args){const output=execFileSync('/private/tmp/lpc-awscli-runtime-2.36.40/bin/aws',[...args,'--profile','lpc-staging-provisioner','--region','us-east-1','--output','json','--no-cli-pager'],{encoding:'utf8',stdio:['ignore','pipe','pipe']});return output.trim()?JSON.parse(output):{};}
async function main(){
 const config=yaml.parse(fs.readFileSync(path.join(process.env.HOME,'.render/cli.yaml'),'utf8'));
 const headers={Authorization:'Bearer '+config.api.key};
 async function secret(name){const r=await fetch('https://api.render.com/v1/env-groups/evg-db6irdvf3r2c73cgdas0/env-vars/'+name,{headers,signal:AbortSignal.timeout(20000)});assert(r.ok);const v=await r.json();return v.value||v.envVar?.value;}
 const [accessKeyId,secretAccessKey,keyArn]=await Promise.all(['S3_ACCESS_KEY','S3_SECRET_KEY','S3_KMS_KEY_ID'].map(secret));
 const client=new sdk.S3Client({region:'us-east-1',credentials:{accessKeyId,secretAccessKey},maxAttempts:1}),owner={Bucket:bucket,ExpectedBucketOwner:'096929701923'},prefix='cases/'+crypto.randomBytes(12).toString('hex')+'/documents/failure-drill-',versions=[];
 const original=aws(['iam','get-role-policy','--role-name',role,'--policy-name',policyName]).PolicyDocument;
 const file='/private/tmp/lpc-staging-scanner-drill-policy.json';
 function setPolicy(value){fs.writeFileSync(file,JSON.stringify(value),{mode:0o600});aws(['iam','put-role-policy','--role-name',role,'--policy-name',policyName,'--policy-document','file://'+file]);}
 const report={passed:[],syntheticOnly:true,productionMutations:0,uploadedBytes:0};
 const sleep=ms=>new Promise(r=>setTimeout(r,ms));
 async function put(Key){const Body=Buffer.from('Synthetic isolated document security verification.');report.uploadedBytes+=Body.length;const r=await client.send(new sdk.PutObjectCommand({...owner,Key,Body,ServerSideEncryption:'aws:kms',SSEKMSKeyId:keyArn}));versions.push({Key,VersionId:r.VersionId});return r.VersionId;}
 async function tag(Key,VersionId){const r=await client.send(new sdk.GetObjectTaggingCommand({...owner,Key,VersionId}));return r.TagSet?.find(t=>t.Key==='GuardDutyMalwareScanStatus')?.Value;}
 async function denied(Key,VersionId,label){let code;try{await client.send(new sdk.GetObjectCommand({...owner,Key,VersionId}));}catch(e){code=e.$metadata?.httpStatusCode;}assert.equal(code,403,label);report.passed.push(label);}
 async function waitTag(Key,VersionId,expected){for(let i=0;i<60;i++){const v=await tag(Key,VersionId);if(v===expected)return;await sleep(2000);}throw Error('ExpectedScanResultNotObserved');}
 try{
  const failKey=prefix+'scan-access-denied.txt',tagKey=prefix+'tagging-unavailable.txt';
  const altered=JSON.parse(JSON.stringify(original));altered.Statement.push({Sid:'IsolatedSyntheticScanFailureDrill',Effect:'Deny',Action:['s3:GetObject','s3:GetObjectVersion'],Resource:'arn:aws:s3:::'+bucket+'/'+failKey});altered.Statement.push({Sid:'IsolatedSyntheticTaggingFailureDrill',Effect:'Deny',Action:['s3:PutObjectTagging','s3:PutObjectVersionTagging'],Resource:'arn:aws:s3:::'+bucket+'/'+tagKey});
  setPolicy(altered);await sleep(15000);
  const failed=await put(failKey);await denied(failKey,failed,'pending object version denied');
  await waitTag(failKey,failed,'ACCESS_DENIED');await denied(failKey,failed,'failed scan remains unreadable');report.passed.push('GuardDuty reports actual scanner ACCESS_DENIED');
  const untagged=await put(tagKey);await sleep(20000);assert.equal(await tag(tagKey,untagged),undefined);await denied(tagKey,untagged,'unavailable scan tag remains unreadable');
  setPolicy(original);await sleep(15000);
  const recovered=await put(failKey);await waitTag(failKey,recovered,'NO_THREATS_FOUND');const r=await client.send(new sdk.GetObjectCommand({...owner,Key:failKey,VersionId:recovered}));await r.Body.transformToByteArray();report.passed.push('restored scanner admits newly scanned clean version');await denied(failKey,failed,'older failed version remains quarantined after recovery');
  const recoveredTag=await put(tagKey);await waitTag(tagKey,recoveredTag,'NO_THREATS_FOUND');report.passed.push('tagging restored for new clean version');
  report.status='passed';
 }catch(e){report.status='failed-closed';report.errorType=e.name;report.errorCode=e.code||null;process.exitCode=1;}
 finally{setPolicy(original);fs.unlinkSync(file);for(const v of versions)await client.send(new sdk.DeleteObjectCommand({...owner,...v}));client.destroy();report.scannerPolicyRestored=true;report.syntheticVersionsRemoved=versions.length;fs.writeFileSync(dir+'/aws-failure-recovery-drill.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));}
}
main().catch(e=>{console.log(JSON.stringify({status:'drill-stopped',errorType:e.name,secretsPrinted:false}));process.exitCode=1;});
