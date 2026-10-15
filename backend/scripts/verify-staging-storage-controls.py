#!/usr/bin/env python3
import subprocess,json,time
from pathlib import Path
AWS='/private/tmp/lpc-awscli-runtime-2.36.40/bin/aws'
def get(args):
 for attempt in range(3):
  r=subprocess.run([AWS,*args,'--profile','lpc-staging-provisioner','--region','us-east-1','--output','json','--no-cli-pager'],capture_output=True,text=True)
  if not r.returncode:return json.loads(r.stdout)
  if r.returncode!=-6:raise RuntimeError('Staging metadata operation failed')
  time.sleep(1)
 raise RuntimeError('Local CLI process aborted')
b='lpc-staging-documents-096929701923-us-east-1';key='13243f5b-28b5-4794-a4de-fa9480ead99b'
report={'bucketPublicAccess':get(['s3api','get-public-access-block','--bucket',b]),'ownership':get(['s3api','get-bucket-ownership-controls','--bucket',b]),'versioning':get(['s3api','get-bucket-versioning','--bucket',b]),'key':get(['kms','describe-key','--key-id',key]),'rotation':get(['kms','get-key-rotation-status','--key-id',key]),'malwarePlan':get(['guardduty','get-malware-protection-plan','--malware-protection-plan-id','d0d09aefa38185a4bd5b'])}
report['bucketPolicy']=json.loads(get(['s3api','get-bucket-policy','--bucket',b])['Policy'])
report['remainingObjectVersions']=get(['s3api','list-object-versions','--bucket',b])
report['scannerPolicy']=get(['iam','get-role-policy','--role-name','lpc-staging-document-scanner','--policy-name','lpc-staging-scan-only'])['PolicyDocument']
assert not any(x.get('Sid','').startswith('IsolatedSynthetic') for x in report['scannerPolicy']['Statement'])
assert all(report['bucketPublicAccess']['PublicAccessBlockConfiguration'].values())
assert report['key']['KeyMetadata']['KeyManager']=='CUSTOMER' and report['key']['KeyMetadata']['KeyState']=='Enabled'
assert report['rotation']['KeyRotationEnabled'] is False
assert report['malwarePlan']['Status']=='ACTIVE'
assert not any(x['Key'].startswith('cases/') for x in report['remainingObjectVersions'].get('Versions',[]))
Path('outputs/document-security-20261013/aws-controls-readonly.json').write_text(json.dumps(report,indent=2)+'\n')
print(json.dumps({'metadataVerified':True,'guardDutyStatus':'ACTIVE','customerManagedKey':True,'rotationEnabled':False,'publicBlockAll':True,'scannerPolicyRestored':True,'syntheticCaseVersionsRemaining':0,'remainingKeys':[x['Key'] for x in report['remainingObjectVersions'].get('Versions',[])]}))
