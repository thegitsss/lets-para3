#!/usr/bin/env python3
"""Capture application credentials privately; never expose CLI secret responses."""
import subprocess,json,os,sys,hashlib
from pathlib import Path
ROOT=Path(__file__).resolve().parents[2]
AWS='/private/tmp/lpc-awscli-runtime-2.36.40/bin/aws'
NODE='/private/tmp/lpc-launch-runtime-24.18.0/node-v24.18.0-darwin-x64/bin/node'
def aws(*args):
 r=subprocess.run([AWS,*args,'--profile','lpc-staging-provisioner','--region','us-east-1','--output','json','--no-cli-pager'],capture_output=True,text=True)
 if r.returncode: raise RuntimeError('AWS operation failed: '+args[0]+'/'+args[1])
 return json.loads(r.stdout)
def main():
 identity=aws('sts','get-caller-identity')
 assert identity['Account']=='096929701923' and identity['Arn']!='arn:aws:iam::096929701923:user/paraconnect-uploader'
 stack=aws('cloudformation','describe-stacks','--stack-name','lpc-document-security-staging')['Stacks'][0]
 assert stack['StackStatus']=='CREATE_COMPLETE'
 outputs={x['OutputKey']:x['OutputValue'] for x in stack['Outputs']}
 (ROOT/'outputs/document-security-20261013/created-resource-identifiers.json').write_text(json.dumps(outputs,indent=2)+'\n')
 assert outputs['Bucket']=='lpc-staging-documents-096929701923-us-east-1'
 keys=aws('iam','list-access-keys','--user-name','lpc-staging-document-app')['AccessKeyMetadata']
 assert not keys,'Do not create duplicate application keys'
 key=aws('iam','create-access-key','--user-name','lpc-staging-document-app')['AccessKey']
 env=dict(os.environ,LPC_DEPLOYMENT_ENV='staging',S3_REGION='us-east-1',S3_BUCKET=outputs['Bucket'],S3_EXPECTED_BUCKET_OWNER='096929701923',REQUIRE_STORAGE_KMS='true',S3_MALWARE_SCAN_REQUIRED='true',S3_KMS_KEY_ID=outputs['KmsKeyArn'],S3_ACCESS_KEY=key['AccessKeyId'],S3_SECRET_KEY=key['SecretAccessKey'],STAGING_STORAGE_TARGET_SHA256=hashlib.sha256(outputs['Bucket'].encode()).hexdigest(),PRODUCTION_STORAGE_TARGET_SHA256=hashlib.sha256(b'paraconnect-uploads').hexdigest())
 for name in ['S3_SESSION_TOKEN','S3_LEGACY_UPLOAD_MANIFEST','S3_LEGACY_UPLOAD_MANIFEST_SHA256']:env.pop(name,None)
 result=subprocess.run([NODE,str(ROOT/'backend/scripts/staging-storage-live.cjs')],env=env,cwd=ROOT,capture_output=True,text=True)
 # This helper only emits a scrubbed report; never emit raw exception text.
 print(result.stdout,flush=True)
 if result.returncode:
  print(json.dumps({'status':'verification-helper-failed','secretsPrinted':False}))
  sys.exit(result.returncode)
if __name__=='__main__':
 try:main()
 except Exception as e:
  print(json.dumps({'status':'stopped','errorType':type(e).__name__,'secretsPrinted':False}));sys.exit(1)
