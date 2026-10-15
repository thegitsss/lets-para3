#!/usr/bin/env python3
"""Start AWS's same-device browser login. Keep auth URLs/codes/tokens out of tool output."""
import json, os, shutil, subprocess, tempfile
from pathlib import Path
aws = shutil.which('aws')
if not aws:
    print(json.dumps({'status':'cli-not-installed','resourcesCreated':0}))
    raise SystemExit(3)
os.umask(0o077)
fd, filename = tempfile.mkstemp(prefix='lpc-staging-aws-login-', suffix='.private.log', dir='/private/tmp')
os.close(fd)
log = Path(filename)
version = subprocess.run([aws, '--version'], capture_output=True, text=True, check=True).stdout.strip()
print(json.dumps({'status':'starting-browser-login','cliVersion':version,'profile':'lpc-staging-provisioner','region':'us-east-1','resourcesCreated':0}), flush=True)
with log.open('w') as stream:
    try:
        result = subprocess.run([aws, 'login', '--profile', 'lpc-staging-provisioner', '--region', 'us-east-1', '--no-cli-pager'], stdin=subprocess.DEVNULL, stdout=stream, stderr=subprocess.STDOUT, timeout=600)
    except subprocess.TimeoutExpired:
        print(json.dumps({'status':'browser-login-expired','credentialsPrinted':False,'resourcesCreated':0}), flush=True)
        raise SystemExit(4)
if result.returncode:
    content = log.read_text(errors='replace')
    known = [name for name in ['AccessDeniedException','AccessDenied','AuthorizationPendingException','TimeoutError','ExpiredTokenException','ConfigurationError'] if name in content]
    print(json.dumps({'status':'browser-login-not-completed','exitCode':result.returncode,'errorTypes':known,'credentialsPrinted':False,'resourcesCreated':0}), flush=True)
    raise SystemExit(result.returncode)
identity = subprocess.run([aws,'sts','get-caller-identity','--profile','lpc-staging-provisioner','--region','us-east-1','--output','json','--no-cli-pager'], capture_output=True,text=True)
if identity.returncode:
    print(json.dumps({'status':'identity-check-failed','credentialsPrinted':False,'resourcesCreated':0}), flush=True)
    raise SystemExit(5)
value = json.loads(identity.stdout)
valid = value.get('Account') == '096929701923' and value.get('Arn') != 'arn:aws:iam::096929701923:user/paraconnect-uploader'
print(json.dumps({'status':'authenticated-identity-verified' if valid else 'wrong-or-forbidden-identity','account':value.get('Account'),'arn':value.get('Arn'),'credentialsPrinted':False,'resourcesCreated':0}), flush=True)
raise SystemExit(0 if valid else 6)
