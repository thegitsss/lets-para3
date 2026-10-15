'use strict';
const crypto=require('node:crypto');
const sdk=require('@aws-sdk/client-s3');
const {ACCOUNT,REGION,BUCKET}=require('../infra/stagingDocumentStorage');
const {execute}=require('../scripts/staging-document-canary.cjs');
const h=v=>crypto.createHash('sha256').update(v).digest('hex');
const keyArn=`arn:aws:kms:${REGION}:${ACCOUNT}:key/12345678-1234-1234-1234-123456789abc`;
const env={LPC_DEPLOYMENT_ENV:'staging',S3_BUCKET:BUCKET,S3_REGION:REGION,S3_EXPECTED_BUCKET_OWNER:ACCOUNT,REQUIRE_STORAGE_KMS:'true',S3_MALWARE_SCAN_REQUIRED:'true',STAGING_STORAGE_TARGET_SHA256:h(BUCKET),PRODUCTION_STORAGE_TARGET_SHA256:h('paraconnect-uploads'),S3_KMS_KEY_ID:keyArn,S3_ACCESS_KEY:'synthetic-only',S3_SECRET_KEY:'synthetic-only'};
afterEach(()=>jest.restoreAllMocks());
test.each([[false,false],[true,false],[false,true]])('bounded canary distinguishes authorization, key validation and unobserved pending denial (validation=%s, immediateScan=%s)',async(validation,immediateScan)=>{
 const objects=new Map(),polls=new Map();let attempts=0;
 const denied=()=>{throw Object.assign(new Error('Synthetic denial'),{name:'AccessDenied',$metadata:{httpStatusCode:403}});};
 const send=jest.spyOn(sdk.S3Client.prototype,'send').mockImplementation(async c=>{
  const i=c.input;
  expect(i.Bucket).toBe(BUCKET);expect(i.ExpectedBucketOwner).toBe(ACCOUNT);
  switch(c.constructor.name){
   case 'GetBucketEncryptionCommand':return {ServerSideEncryptionConfiguration:{Rules:[{ApplyServerSideEncryptionByDefault:{SSEAlgorithm:'aws:kms',KMSMasterKeyID:keyArn}}]}};
   case 'PutObjectCommand':attempts++;if(validation&&i.SSEKMSKeyId?.endsWith('000000000000'))throw Object.assign(new Error('Synthetic nonexistent key'),{name:'KMS.NotFoundException',$metadata:{httpStatusCode:400}});if(i.Tagging||i.ServerSideEncryption!=='aws:kms'||i.SSEKMSKeyId!==keyArn)return denied();objects.set(i.Key,i.Body);return {VersionId:i.Key.endsWith('.txt')?'infected-version':'clean-version',ServerSideEncryption:'aws:kms',SSEKMSKeyId:keyArn};
   case 'PutObjectTaggingCommand':return denied();
   case 'GetObjectTaggingCommand':{const count=(polls.get(i.Key)||0)+1;polls.set(i.Key,count);return {TagSet:i.Key.endsWith('.txt')?[{Key:'GuardDutyMalwareScanStatus',Value:'THREATS_FOUND'}]:count===1&&!immediateScan?[]:[{Key:'GuardDutyMalwareScanStatus',Value:'NO_THREATS_FOUND'}]};}
   case 'HeadObjectCommand':return {SSEKMSKeyId:keyArn};
   case 'GetObjectCommand':if(i.Key.endsWith('.txt')||(polls.get(i.Key)||0)<2)return denied();return {Body:{transformToByteArray:async()=>objects.get(i.Key)}};
   default:throw Error('Unexpected storage command');
  }
 });
 const fetch=jest.spyOn(global,'fetch').mockResolvedValue({status:403});
 const report=await execute(env);
 expect(report.status).toBe(immediateScan?'partial-pending-read-not-observed':'provider-canary-passed');
 if(immediateScan){expect(report.pendingRead).toMatch(/^not observed:/);expect(report.passed).not.toContain('pending version unreadable');}
 else{expect(report.pendingRead).toBe('verified');expect(report.passed).toContain('pending version unreadable');}
 expect(report.productionMutations).toBe(0);
 expect(attempts).toBe(5);expect(objects.size).toBe(2);expect(report.passed).toContain(validation?'nonexistent KMS key rejected by provider validation':'wrong KMS key rejected by authorization');expect(report.passed).toContain('signed URL cannot bypass infected quarantine');expect(fetch).toHaveBeenCalledTimes(2);expect(send).toHaveBeenCalled();
});
test('a provider failure retains only the uniquely owned canary scope for cleanup',async()=>{
 const failure=Object.assign(new Error('Synthetic provider failure'),{name:'ServiceUnavailable',$metadata:{httpStatusCode:503}});
 jest.spyOn(sdk.S3Client.prototype,'send').mockRejectedValue(failure);
 await expect(execute(env)).rejects.toBe(failure);
 expect(failure.canaryReport.bucket).toBe(BUCKET);
 expect(failure.canaryReport.objectPrefix).toMatch(/^cases\/[a-f0-9]{24}\/documents\/scan-required-canary-$/);
 expect(failure.canaryReport.syntheticOnly).toBe(true);
 expect(failure.canaryReport.objectVersions).toEqual([]);
 expect(failure.canaryReport).not.toHaveProperty('S3_SECRET_KEY');
});
