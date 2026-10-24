import sys,pathlib,zipfile,stat,json,hashlib
archive=pathlib.Path(sys.argv[1]);target=pathlib.Path(sys.argv[2]);kind=sys.argv[3]
assert kind in ['plan','shard'];assert not archive.is_symlink();assert target.parent.resolve()==archive.parent.resolve();assert not target.is_symlink();target.mkdir(mode=0o700,exist_ok=True)
required=['plan.json'] if kind=='plan' else ['shard.json','results.json','results.xml','mongo.jsonl','http.jsonl']
with zipfile.ZipFile(archive) as z:
 rows=z.infolist();assert len(rows)<100000 and len({x.filename for x in rows})==len(rows) and sum(x.file_size for x in rows)<10*1024**3
 for x in rows:
  p=pathlib.PurePosixPath(x.filename);assert not p.is_absolute() and '..' not in p.parts and '\\' not in x.filename and not stat.S_ISLNK(x.external_attr>>16)
 assert z.testzip() is None;assert all(n in z.namelist() for n in required);files={}
 for n in required:
  data=z.read(n);p=target/n
  if p.exists():assert not p.is_symlink() and p.read_bytes()==data
  else:
   with p.open('xb') as f:f.write(data)
   p.chmod(0o600)
  files[n]=hashlib.sha256(data).hexdigest()
print(json.dumps({'allMemberCRCsVerified':True,'members':len(rows),'extractedRequiredFiles':files}))
