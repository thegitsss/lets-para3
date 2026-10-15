'use strict';
const {buildStagingDocumentStorage,ACCOUNT,REGION,BUCKET,APP_NAME,SCANNER_NAME}=require('../infra/stagingDocumentStorage');
const template=buildStagingDocumentStorage();
const statements=template.Resources.DocumentBucketPolicy.Properties.PolicyDocument.Statement;
const app=`arn:aws:iam::${ACCOUNT}:user/${APP_NAME}`, scanner=`arn:aws:iam::${ACCOUNT}:role/${SCANNER_NAME}`;
const keyArn=`arn:aws:kms:${REGION}:${ACCOUNT}:key/fixture-key`;
function resolve(value){return value&&typeof value==='object'&&value['Fn::GetAtt']?keyArn:value;}
// Constrained local model of the exact explicit-deny operators used here.
// This is not AWS IAM simulation or provider acceptance evidence.
function denied(action,context){return statements.some(s=>{
 const actions=Array.isArray(s.Action)?s.Action:[s.Action];
 if(!actions.some(a=>a===action||a==='s3:*'))return false;
 return Object.entries(s.Condition||{}).every(([operator,conditions])=>Object.entries(conditions).every(([k,v])=>{
  const actual=context[k], expected=(Array.isArray(v)?v:[v]).map(resolve);
  if(operator==='ArnNotEquals'||operator==='StringNotEquals')return !expected.includes(actual);
  if(operator==='Bool')return String(actual)===String(v);
  if(operator==='Null')return String(actual==null)===String(v);
  if(operator==='NumericLessThan')return actual!=null&&Number(actual)<Number(v);
  throw Error('Unsupported policy operator '+operator);
 }));
});}
const base={'aws:PrincipalArn':app,'aws:SecureTransport':'true','aws:PrincipalIsAWSService':'false','s3:TlsVersion':'1.2','s3:x-amz-server-side-encryption':'aws:kms','s3:x-amz-server-side-encryption-aws-kms-key-id':keyArn};
test.each(['PENDING','THREATS_FOUND','UNSUPPORTED','ACCESS_DENIED','FAILED','UNKNOWN',undefined])('read is quarantined for %s, including historical versions',result=>{
 const c={...base,'s3:ExistingObjectTag/GuardDutyMalwareScanStatus':result};
 expect(denied('s3:GetObject',c)).toBe(true);expect(denied('s3:GetObjectVersion',c)).toBe(true);
});
test('only clean current/version reads escape explicit quarantine',()=>expect(denied('s3:GetObject',{...base,'s3:ExistingObjectTag/GuardDutyMalwareScanStatus':'NO_THREATS_FOUND'})).toBe(false));
test('scanner can inspect pending content and validate the bucket without app SSE headers',()=>{
 expect(denied('s3:GetObject',{...base,'aws:PrincipalArn':scanner})).toBe(false);
 expect(denied('s3:PutObject',{'aws:PrincipalArn':scanner,'aws:SecureTransport':'true'})).toBe(false);
});
test.each(['s3:PutObjectTagging','s3:DeleteObjectTagging','s3:PutObjectVersionTagging','s3:DeleteObjectVersionTagging'])('application cannot forge or remove results through %s',action=>expect(denied(action,base)).toBe(true));
test('upload cannot forge a clean tag or copy inherited tags',()=>{
 expect(denied('s3:PutObject',{...base,'s3:RequestObjectTag/GuardDutyMalwareScanStatus':'NO_THREATS_FOUND'})).toBe(true);
 expect(denied('s3:PutObject',{...base,'s3:x-amz-copy-source':'/other/key'})).toBe(true);
});
test.each([undefined,'AES256','aws:kms:dsse'])('missing or alternative encryption %s is denied',value=>expect(denied('s3:PutObject',{...base,'s3:x-amz-server-side-encryption':value})).toBe(true));
test('wrong KMS key and production identity are denied',()=>{
 expect(denied('s3:PutObject',{...base,'s3:x-amz-server-side-encryption-aws-kms-key-id':'arn:other'})).toBe(true);
 expect(denied('s3:GetObject',{...base,'aws:PrincipalArn':`arn:aws:iam::${ACCOUNT}:user/production`,'s3:ExistingObjectTag/GuardDutyMalwareScanStatus':'NO_THREATS_FOUND'})).toBe(true);
});
test('HTTP and old TLS denied, isolated encrypted upload permitted',()=>{
 expect(denied('s3:PutObject',{...base,'aws:SecureTransport':'false'})).toBe(true);
 expect(denied('s3:PutObject',{...base,'s3:TlsVersion':'1.1'})).toBe(true);
 expect(denied('s3:PutObject',base)).toBe(false);
});
test.each([{bucket:'paraconnect-uploads'},{account:'123456789012'},{region:'us-west-2'}])('generator rejects another target %#',options=>expect(()=>buildStagingDocumentStorage(options)).toThrow(/isolated staging/));
test('no access keys, existing production resource, detector, worker or plaintext secret is provisioned',()=>{
 expect(Object.values(template.Resources).map(r=>r.Type)).not.toContain('AWS::IAM::AccessKey');
 expect(JSON.stringify(template)).not.toContain('paraconnect-uploads');
 expect(template.Resources.DocumentBucket.DeletionPolicy).toBe('Retain');
 expect(template.Resources.DocumentKey.DeletionPolicy).toBe('Retain');
 expect(template.Resources.MalwareProtection.Properties.ProtectedResource.S3Bucket.BucketName).toEqual({Ref:'DocumentBucket'});
});
test('resource dependency graph has no circular creation dependencies',()=>{
 const graph={};
 for(const[id,r]of Object.entries(template.Resources)){
  const refs=new Set([].concat(r.DependsOn||[]));
  function walk(x){if(!x||typeof x!=='object')return;if(x.Ref&&template.Resources[x.Ref])refs.add(x.Ref);if(x['Fn::GetAtt'])refs.add(x['Fn::GetAtt'][0]);for(const v of Object.values(x))walk(v);}
  walk(r.Properties);graph[id]=refs;
 }
 function visit(id,path){expect(path).not.toContain(id);for(const dependency of graph[id])visit(dependency,[...path,id]);}
 for(const id of Object.keys(graph))visit(id,[]);
});
const {validate}=require('../scripts/staging-document-canary.cjs');
const hash=value=>require('node:crypto').createHash('sha256').update(value).digest('hex');
const fixtureEnv={LPC_DEPLOYMENT_ENV:'staging',S3_BUCKET:BUCKET,S3_REGION:REGION,S3_EXPECTED_BUCKET_OWNER:ACCOUNT,REQUIRE_STORAGE_KMS:'true',S3_MALWARE_SCAN_REQUIRED:'true',STAGING_STORAGE_TARGET_SHA256:hash(BUCKET),PRODUCTION_STORAGE_TARGET_SHA256:hash('paraconnect-uploads'),S3_KMS_KEY_ID:`arn:aws:kms:${REGION}:${ACCOUNT}:key/12345678-1234-1234-1234-123456789abc`,S3_ACCESS_KEY:'synthetic-only',S3_SECRET_KEY:'synthetic-only'};
test('canary accepts only a complete isolated configuration',()=>expect(()=>validate(fixtureEnv)).not.toThrow());
test.each([{S3_BUCKET:'paraconnect-uploads'},{S3_REGION:'us-west-2'},{S3_LEGACY_UPLOAD_MANIFEST:'/private/legacy.json'},{S3_MALWARE_SCAN_REQUIRED:'false'},{S3_KMS_KEY_ID:'alias/production'},{S3_EXPECTED_BUCKET_OWNER:'123456789012'}])('canary refuses unsafe target/scan configuration %#',override=>expect(()=>validate({...fixtureEnv,...override})).toThrow());
