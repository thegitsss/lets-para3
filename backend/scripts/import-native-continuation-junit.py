import sys,json,pathlib,zipfile,hashlib,xml.etree.ElementTree as ET
manifest_path=pathlib.Path(sys.argv[1]);manifest=json.loads(manifest_path.read_text());rows=[];artifacts=[]
for a in manifest['artifacts']:
 name=a['name']
 if not name.startswith('browser-') or name.startswith(('browser-failure-','browser-collection-')):continue
 group=name[len('browser-'):-len('-38671785162-1')]
 zpath=manifest_path.parent/a['localName'];h=hashlib.sha256(zpath.read_bytes()).hexdigest()
 assert h==a['sha256'] and a['rawMetadata']['digest']=='sha256:'+h and a['zip']['allMemberCRCsVerified'] is True
 with zipfile.ZipFile(zpath) as z:
  for member in z.namelist():
   if not member.endswith('.xml'):continue
   raw=z.read(member);tree=ET.fromstring(raw)
   for suite in tree.iter('testsuite'):
    for case in suite.findall('testcase'):
     engine=suite.get('hostname');title=case.get('name');prefix='['+engine+'] ' if engine else ''
     if prefix and title.startswith(prefix):title=title[len(prefix):]
     rows.append({'source':'backend/tests/playwright/'+('accessibility/' if group=='public-accessibility' else 'performance/' if group=='public-performance' else '')+case.get('classname'),'title':title,'engine':engine,'group':group,'junitState':'failed' if case.find('failure') is not None or case.find('error') is not None else 'skipped' if case.find('skipped') is not None else 'passed-fragment','proofClass':'junit-business-fragment-only','artifactId':a['id'],'archivePath':str(zpath),'archiveSha256':h,'member':member,'memberSha256':hashlib.sha256(raw).hexdigest(),'noRetryOrNativeErrorOrCleanupInference':True})
   artifacts.append({'artifactId':a['id'],'archivePath':str(zpath),'archiveSha256':h,'member':member,'memberSha256':hashlib.sha256(raw).hexdigest()})
json.dump({'schemaVersion':1,'rows':rows,'artifacts':artifacts,'limits':['JUnit-only is business-fragment evidence, never full JSON, retry-free, flaky-free, native error-free, context-lifetime or cleanup proof.']},open(sys.argv[2],'w'),indent=2)
