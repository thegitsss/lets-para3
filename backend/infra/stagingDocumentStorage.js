'use strict';
// Builds an approval-ready template only. No AWS SDK, credentials, or deployment calls.
const ACCOUNT='096929701923', REGION='us-east-1';
const BUCKET=`lpc-staging-documents-${ACCOUNT}-${REGION}`;
const APP_NAME='lpc-staging-document-app', SCANNER_NAME='lpc-staging-document-scanner';
const SCAN_TAG='GuardDutyMalwareScanStatus';
const ref=id=>({Ref:id}), att=(id,name='Arn')=>({'Fn::GetAtt':[id,name]});
const policy=Statement=>({Version:'2012-10-17',Statement});
const statement=(Sid,Effect,Action,Resource,Condition)=>({Sid,Effect,Action,Resource,...(Condition?{Condition}:{})});
function buildStagingDocumentStorage({account=ACCOUNT,region=REGION,bucket=BUCKET}={}) {
 if(account!==ACCOUNT||region!==REGION||bucket!==BUCKET)throw Error('Only the reviewed isolated staging account, region and bucket are allowed.');
 const bucketArn=`arn:aws:s3:::${bucket}`, objects=bucketArn+'/*';
 const appArn=`arn:aws:iam::${account}:user/${APP_NAME}`, scannerArn=`arn:aws:iam::${account}:role/${SCANNER_NAME}`;
 const uploads=['cases/*','paralegal-resumes/*','paralegal-certificates/*','paralegal-writing-samples/*','profile-photos/*'].map(p=>bucketArn+'/'+p);
 const s3Kms={StringEquals:{'kms:ViaService':`s3.${region}.amazonaws.com`,'kms:CallerAccount':account},StringLike:{'kms:EncryptionContext:aws:s3:arn':[bucketArn,objects]}};
 const tags=[{Key:'Environment',Value:'staging'},{Key:'Application',Value:'LPC'},{Key:'Data',Value:'synthetic-only'}];
 const exceptScanner={ArnNotEquals:{'aws:PrincipalArn':scannerArn}};
 const dataActions=['s3:GetObject','s3:GetObjectVersion','s3:PutObject','s3:DeleteObject','s3:DeleteObjectVersion','s3:GetObjectTagging','s3:GetObjectVersionTagging','s3:PutObjectTagging','s3:PutObjectVersionTagging','s3:DeleteObjectTagging','s3:DeleteObjectVersionTagging'];
 const deny=(sid,actions,resource,conditions)=>({...statement(sid,'Deny',actions,resource,conditions),Principal:'*'});
 const resources={
  ApplicationUser:{Type:'AWS::IAM::User',Properties:{UserName:APP_NAME,Tags:tags}},
  ScannerRole:{Type:'AWS::IAM::Role',Properties:{RoleName:SCANNER_NAME,AssumeRolePolicyDocument:policy([{Effect:'Allow',Principal:{Service:'malware-protection-plan.guardduty.amazonaws.com'},Action:'sts:AssumeRole'}]),Tags:tags}},
  DocumentKey:{Type:'AWS::KMS::Key',DeletionPolicy:'Retain',UpdateReplacePolicy:'Retain',Properties:{Description:'Isolated LPC synthetic staging documents; never production',KeySpec:'SYMMETRIC_DEFAULT',KeyUsage:'ENCRYPT_DECRYPT',EnableKeyRotation:false,PendingWindowInDays:30,KeyPolicy:policy([{Sid:'AccountAdministration',Effect:'Allow',Principal:{AWS:`arn:aws:iam::${account}:root`},Action:'kms:*',Resource:'*'},{Sid:'StagingDataUseOnlyThroughS3',Effect:'Allow',Principal:{AWS:[att('ApplicationUser'),att('ScannerRole')]},Action:['kms:GenerateDataKey','kms:Decrypt'],Resource:'*',Condition:s3Kms}]),Tags:tags}},
  DocumentKeyAlias:{Type:'AWS::KMS::Alias',Properties:{AliasName:'alias/lpc-staging-documents',TargetKeyId:ref('DocumentKey')}},
  DocumentBucket:{Type:'AWS::S3::Bucket',DeletionPolicy:'Retain',UpdateReplacePolicy:'Retain',Properties:{BucketName:bucket,PublicAccessBlockConfiguration:{BlockPublicAcls:true,IgnorePublicAcls:true,BlockPublicPolicy:true,RestrictPublicBuckets:true},OwnershipControls:{Rules:[{ObjectOwnership:'BucketOwnerEnforced'}]},VersioningConfiguration:{Status:'Enabled'},BucketEncryption:{ServerSideEncryptionConfiguration:[{ServerSideEncryptionByDefault:{SSEAlgorithm:'aws:kms',KMSMasterKeyID:att('DocumentKey')},BucketKeyEnabled:true}]},NotificationConfiguration:{EventBridgeConfiguration:{EventBridgeEnabled:true}},CorsConfiguration:{CorsRules:[{AllowedOrigins:['https://lets-paraconnect-backend.onrender.com'],AllowedMethods:['PUT'],AllowedHeaders:['content-type','content-disposition','if-none-match','x-amz-*'],ExposedHeaders:['ETag','x-amz-version-id'],MaxAge:300}]},LifecycleConfiguration:{Rules:[{Id:'AbortIncompleteSyntheticMultipart',Status:'Enabled',AbortIncompleteMultipartUpload:{DaysAfterInitiation:1}}]},Tags:tags}},
  ApplicationPermissions:{Type:'AWS::IAM::Policy',Properties:{PolicyName:'lpc-staging-documents-only',Users:[ref('ApplicationUser')],PolicyDocument:policy([
   statement('DocumentObjectAccess','Allow',['s3:PutObject','s3:GetObject','s3:GetObjectVersion','s3:GetObjectTagging','s3:GetObjectVersionTagging','s3:DeleteObject','s3:DeleteObjectVersion','s3:AbortMultipartUpload','s3:ListMultipartUploadParts'],uploads),
   statement('ScopedDocumentListings','Allow',['s3:ListBucket','s3:ListBucketVersions'],bucketArn,{StringLike:{'s3:prefix':['cases/*','paralegal-resumes/*','paralegal-certificates/*','paralegal-writing-samples/*','profile-photos/*']}}),
   statement('ReadOwnBucketConfiguration','Allow',['s3:GetBucketLocation','s3:GetEncryptionConfiguration','s3:GetBucketVersioning','s3:GetBucketPublicAccessBlock','s3:GetBucketOwnershipControls'],bucketArn),
   statement('OwnKeyOnly','Allow',['kms:GenerateDataKey','kms:Decrypt'],att('DocumentKey'),s3Kms)
  ])}},
  ScannerPermissions:{Type:'AWS::IAM::Policy',Properties:{PolicyName:'lpc-staging-scan-only',Roles:[ref('ScannerRole')],PolicyDocument:policy([
   statement('ManageOnlyGuardDutyManagedRules','Allow',['events:PutRule','events:DeleteRule','events:PutTargets','events:RemoveTargets'],`arn:aws:events:${region}:${account}:rule/DO-NOT-DELETE-AmazonGuardDutyMalwareProtectionS3*`,{StringEquals:{'events:ManagedBy':'malware-protection-plan.guardduty.amazonaws.com'}}),
   statement('ObserveManagedRule','Allow',['events:DescribeRule','events:ListTargetsByRule'],`arn:aws:events:${region}:${account}:rule/DO-NOT-DELETE-AmazonGuardDutyMalwareProtectionS3*`),
   statement('ReadForScanAndApplyResults','Allow',['s3:GetObject','s3:GetObjectVersion','s3:GetObjectTagging','s3:GetObjectVersionTagging','s3:PutObjectTagging','s3:PutObjectVersionTagging'],objects),
   statement('OwnBucketEventBridgeAndOwnership','Allow',['s3:GetBucketNotification','s3:PutBucketNotification','s3:ListBucket'],bucketArn),
   statement('ValidationObjectOnly','Allow','s3:PutObject',bucketArn+'/malware-protection-resource-validation-object'),
   statement('OwnKeyForScanAndValidation','Allow',['kms:GenerateDataKey','kms:Decrypt'],att('DocumentKey'),s3Kms)
  ])}},
  DocumentBucketPolicy:{Type:'AWS::S3::BucketPolicy',Properties:{Bucket:ref('DocumentBucket'),PolicyDocument:policy([
   deny('TLSOnly','s3:*',[bucketArn,objects],{Bool:{'aws:SecureTransport':'false'}}),
   deny('RequireTLS12','s3:*',[bucketArn,objects],{NumericLessThan:{'s3:TlsVersion':'1.2'},Bool:{'aws:PrincipalIsAWSService':'false'}}),
   deny('DataOnlyForStagingIdentities',dataActions,objects,{ArnNotEquals:{'aws:PrincipalArn':[appArn,scannerArn]}}),
   deny('NoReadWithoutCleanScan',['s3:GetObject','s3:GetObjectVersion'],objects,{...exceptScanner,StringNotEquals:{['s3:ExistingObjectTag/'+SCAN_TAG]:'NO_THREATS_FOUND'}}),
   deny('ScannerOwnsTags',['s3:PutObjectTagging','s3:PutObjectVersionTagging','s3:DeleteObjectTagging','s3:DeleteObjectVersionTagging'],objects,exceptScanner),
   deny('NoForgedScanTagAtUpload','s3:PutObject',objects,{...exceptScanner,Null:{['s3:RequestObjectTag/'+SCAN_TAG]:'false'}}),
   deny('NoCopyTagLaundering','s3:PutObject',objects,{...exceptScanner,Null:{'s3:x-amz-copy-source':'false'}}),
   deny('ExplicitKmsRequired','s3:PutObject',objects,{...exceptScanner,StringNotEquals:{'s3:x-amz-server-side-encryption':'aws:kms'}}),
   deny('ExactStagingKeyRequired','s3:PutObject',objects,{...exceptScanner,StringNotEquals:{'s3:x-amz-server-side-encryption-aws-kms-key-id':att('DocumentKey')}})
  ])}},
  MalwareProtection:{Type:'AWS::GuardDuty::MalwareProtectionPlan',DependsOn:['ScannerPermissions','DocumentBucketPolicy'],Properties:{Role:att('ScannerRole'),ProtectedResource:{S3Bucket:{BucketName:ref('DocumentBucket')}},Actions:{Tagging:{Status:'ENABLED'}},Tags:tags}}
 };
 return {AWSTemplateFormatVersion:'2010-09-09',Description:'PROPOSED ONLY: isolated LPC staging documents, customer-managed KMS and scan quarantine. No existing production resources.',Metadata:{LPC:{Account:account,Region:region,Environment:'staging',RequiresOwnerCostApproval:true,CreatesAccessKeys:false,EmailChecksRemainClosed:true,NoNewRenderServices:true}},Resources:resources,Outputs:{Bucket:{Value:ref('DocumentBucket')},KmsKeyArn:{Value:att('DocumentKey')},ApplicationUserArn:{Value:att('ApplicationUser')},ScannerRoleArn:{Value:att('ScannerRole')},MalwareProtectionPlanId:{Value:att('MalwareProtection','MalwareProtectionPlanId')},MalwareProtectionPlanArn:{Value:att('MalwareProtection')},MalwareProtectionPlanStatus:{Value:att('MalwareProtection','Status')}}};
}
module.exports={ACCOUNT,REGION,BUCKET,APP_NAME,SCANNER_NAME,buildStagingDocumentStorage};
