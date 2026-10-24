'use strict';
const {ACCOUNT,REGION,BUCKET,APP_NAME,SCANNER_NAME}=require('./stagingDocumentStorage');
const p=(Sid,Action,Resource,Condition)=>({Sid,Effect:'Allow',Action,Resource,...(Condition?{Condition}:{})});
const tags={'aws:RequestTag/Environment':'staging','aws:RequestTag/Application':'LPC','aws:RequestTag/Data':'synthetic-only'};
const existingTags={'aws:ResourceTag/Environment':'staging','aws:ResourceTag/Application':'LPC','aws:ResourceTag/Data':'synthetic-only'};
function buildProvisioningPermissions(){
 const user=`arn:aws:iam::${ACCOUNT}:user/${APP_NAME}`,role=`arn:aws:iam::${ACCOUNT}:role/${SCANNER_NAME}`,bucket=`arn:aws:s3:::${BUCKET}`,key=`arn:aws:kms:${REGION}:${ACCOUNT}:key/*`,alias=`arn:aws:kms:${REGION}:${ACCOUNT}:alias/lpc-staging-documents`,plan=`arn:aws:guardduty:${REGION}:${ACCOUNT}:malware-protection-plan/*`;
 return {Version:'2012-10-17',Statement:[
  p('ValidateLocalTemplate',['cloudformation:ValidateTemplate'],'*'),
  p('CreateOneNamedStack',['cloudformation:CreateStack'],`arn:aws:cloudformation:${REGION}:${ACCOUNT}:stack/lpc-document-security-staging/*`,{StringEquals:tags,Null:{'cloudformation:RoleArn':'true'}}),
  p('ReadAndRollbackOneStack',['cloudformation:DescribeStacks','cloudformation:DescribeStackEvents','cloudformation:GetTemplate','cloudformation:ListStackResources','cloudformation:DeleteStack'],`arn:aws:cloudformation:${REGION}:${ACCOUNT}:stack/lpc-document-security-staging/*`),
  p('OnlyStagingApplicationUser',['iam:CreateUser','iam:GetUser','iam:TagUser','iam:ListUserTags','iam:PutUserPolicy','iam:GetUserPolicy','iam:ListUserPolicies','iam:DeleteUserPolicy','iam:DeleteUser','iam:CreateAccessKey','iam:ListAccessKeys','iam:DeleteAccessKey'],user),
  p('OnlyStagingScannerRole',['iam:CreateRole','iam:GetRole','iam:TagRole','iam:ListRoleTags','iam:PutRolePolicy','iam:GetRolePolicy','iam:ListRolePolicies','iam:DeleteRolePolicy','iam:DeleteRole'],role),
  p('PassOnlyScannerToGuardDuty','iam:PassRole',role,{StringEquals:{'iam:PassedToService':'malware-protection-plan.guardduty.amazonaws.com'}}),
  p('OnlyStagingBucketConfiguration',['s3:CreateBucket','s3:DeleteBucket','s3:GetBucketLocation','s3:ListBucket','s3:GetBucketAcl','s3:GetBucketPolicy','s3:PutBucketPolicy','s3:DeleteBucketPolicy','s3:GetEncryptionConfiguration','s3:PutEncryptionConfiguration','s3:GetBucketVersioning','s3:PutBucketVersioning','s3:GetBucketPublicAccessBlock','s3:PutBucketPublicAccessBlock','s3:GetBucketOwnershipControls','s3:PutBucketOwnershipControls','s3:GetBucketCORS','s3:PutBucketCORS','s3:GetBucketNotification','s3:PutBucketNotification','s3:GetLifecycleConfiguration','s3:PutLifecycleConfiguration','s3:GetBucketTagging','s3:PutBucketTagging'],bucket),
  p('ReadAliasForCloudFormationCallback','kms:ListAliases','*'),
  p('CreateTaggedStagingKey','kms:CreateKey','*',{StringEquals:{...tags,'kms:KeySpec':'SYMMETRIC_DEFAULT','kms:KeyUsage':'ENCRYPT_DECRYPT'}}),
  p('ReadAndConfigureOnlyTaggedStagingKeys',['kms:DescribeKey','kms:GetKeyPolicy','kms:GetKeyRotationStatus','kms:ListResourceTags','kms:PutKeyPolicy'],key,{StringEquals:{'aws:ResourceTag/Environment':'staging','aws:ResourceTag/Application':'LPC','aws:ResourceTag/Data':'synthetic-only'}}),
  p('TagOnlyStagingKey','kms:TagResource',key,{StringEquals:{...tags,...existingTags}}),
  p('ExactStagingAlias','kms:CreateAlias',alias),
  p('AliasTargetMustBeTaggedStagingKey','kms:CreateAlias',key,{StringEquals:{'aws:ResourceTag/Environment':'staging','aws:ResourceTag/Application':'LPC','aws:ResourceTag/Data':'synthetic-only'}}),
  p('RemoveOnlyStagingAlias','kms:DeleteAlias',alias),
  p('CreateTaggedStagingProtectionPlan','guardduty:CreateMalwareProtectionPlan','*',{StringEquals:tags}),
  p('ObserveAndRetireOnlyTaggedStagingPlan',['guardduty:GetMalwareProtectionPlan','guardduty:ListTagsForResource','guardduty:DeleteMalwareProtectionPlan'],plan,{StringEquals:{'aws:ResourceTag/Environment':'staging','aws:ResourceTag/Application':'LPC','aws:ResourceTag/Data':'synthetic-only'}}),
  p('TagStagingPlan','guardduty:TagResource',plan,{StringEquals:{...tags,...existingTags}})
 ].map(s=>({...s,Condition:{...s.Condition,StringEquals:{...s.Condition?.StringEquals,'aws:RequestedRegion':REGION,'aws:PrincipalAccount':ACCOUNT}}}))};
}
module.exports={buildProvisioningPermissions};
if(require.main===module)console.log(JSON.stringify(buildProvisioningPermissions(),null,2));
