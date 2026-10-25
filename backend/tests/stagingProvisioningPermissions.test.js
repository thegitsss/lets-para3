'use strict';
const {buildProvisioningPermissions}=require('../infra/stagingDocumentProvisioningPermissions');
const policy=buildProvisioningPermissions();
const glob=(pattern,value)=>new RegExp('^'+pattern.split('*').map(s=>s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('.*')+'$').test(value);
const context={'aws:RequestedRegion':'us-east-1','aws:PrincipalAccount':'096929701923'};
function allowed(action,resource,additional={}){const c={...context,...additional};return policy.Statement.some(s=>[].concat(s.Action).includes(action)&&[].concat(s.Resource).some(r=>glob(r,resource))&&Object.entries(s.Condition||{}).every(([op,entries])=>Object.entries(entries).every(([k,v])=>op==='StringEquals'?c[k]===v:op==='Null'?String(c[k]==null)===v:false)));}
test('bucket configuration grant excludes production and any second bucket',()=>{
 expect(allowed('s3:CreateBucket','arn:aws:s3:::lpc-staging-documents-096929701923-us-east-1')).toBe(true);
 expect(allowed('s3:PutBucketPolicy','arn:aws:s3:::paraconnect-uploads')).toBe(false);
 expect(allowed('s3:CreateBucket','arn:aws:s3:::another-staging-bucket')).toBe(false);
});
test.each(['iam:PutUserPolicy','iam:CreateAccessKey','iam:DeleteUser'])('cannot modify or mint credentials for production uploader with %s',action=>expect(allowed(action,'arn:aws:iam::096929701923:user/paraconnect-uploader')).toBe(false));
test('tag-free or production-tagged KMS creation is not granted',()=>{
 const requestTags={'aws:RequestTag/Environment':'staging','aws:RequestTag/Application':'LPC','aws:RequestTag/Data':'synthetic-only','kms:KeySpec':'SYMMETRIC_DEFAULT','kms:KeyUsage':'ENCRYPT_DECRYPT'};
 expect(allowed('kms:CreateKey','*',requestTags)).toBe(true);expect(allowed('kms:CreateKey','*')).toBe(false);expect(allowed('kms:CreateKey','*',{...requestTags,'aws:RequestTag/Environment':'production'})).toBe(false);
});
test('production KMS key and existing production scan plan cannot be reconfigured',()=>{
 expect(allowed('kms:PutKeyPolicy','arn:aws:kms:us-east-1:096929701923:key/production-key',{'aws:ResourceTag/Environment':'production'})).toBe(false);
 expect(allowed('guardduty:DeleteMalwareProtectionPlan','arn:aws:guardduty:us-east-1:096929701923:malware-protection-plan/12d0866a656f5bf59eb2',{'aws:ResourceTag/Environment':'production'})).toBe(false);
 expect(allowed('guardduty:CreateDetector','*')).toBe(false);
});
test.each([
 ['kms:TagResource','arn:aws:kms:us-east-1:096929701923:key/existing-key'],
 ['guardduty:TagResource','arn:aws:guardduty:us-east-1:096929701923:malware-protection-plan/existing-plan'],
])('%s cannot relabel an unprotected or production resource to gain staging authority',(action,resource)=>{
 const requestTags={'aws:RequestTag/Environment':'staging','aws:RequestTag/Application':'LPC','aws:RequestTag/Data':'synthetic-only'};
 const existingTags={'aws:ResourceTag/Environment':'staging','aws:ResourceTag/Application':'LPC','aws:ResourceTag/Data':'synthetic-only'};
 expect(allowed(action,resource,requestTags)).toBe(false);
 expect(allowed(action,resource,{...requestTags,'aws:ResourceTag/Environment':'production'})).toBe(false);
 expect(allowed(action,resource,{...requestTags,...existingTags})).toBe(true);
 for(const key of Object.keys(existingTags)){
  const missing={...requestTags,...existingTags};delete missing[key];
  expect(allowed(action,resource,missing)).toBe(false);
 }
 expect(allowed(action,resource,{...requestTags,...existingTags,'aws:RequestTag/Data':'real-data'})).toBe(false);
});
test('PassRole cannot target CloudFormation or a production scanner',()=>{
 const role='arn:aws:iam::096929701923:role/lpc-staging-document-scanner';
 expect(allowed('iam:PassRole',role,{'iam:PassedToService':'malware-protection-plan.guardduty.amazonaws.com'})).toBe(true);
 expect(allowed('iam:PassRole',role,{'iam:PassedToService':'cloudformation.amazonaws.com'})).toBe(false);
 expect(allowed('iam:PassRole','arn:aws:iam::096929701923:role/production-scanner',{'iam:PassedToService':'malware-protection-plan.guardduty.amazonaws.com'})).toBe(false);
});
test('another region/account cannot use any grant',()=>{
 const resource='arn:aws:s3:::lpc-staging-documents-096929701923-us-east-1';
 expect(allowed('s3:CreateBucket',resource,{'aws:RequestedRegion':'us-west-2'})).toBe(false);
 expect(allowed('s3:CreateBucket',resource,{'aws:PrincipalAccount':'123456789012'})).toBe(false);
});
