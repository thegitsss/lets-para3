'use strict';
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto'),{spawn}=require('node:child_process');
const backend=path.resolve(__dirname,'..');
const manifest=require('../tests/playwright/acceptance/groups.json');
const argv=process.argv.slice(2),flag=argv[0];
if(flag==='--list-groups'&&argv.length===1){console.log(JSON.stringify(manifest.groups.map(g=>g.name)));process.exit(0);}
if(flag==='--verify-groups'&&argv.length===1){require('./verify-critical-browser-groups');return;}
if(!['--group','--suite','--collect-group'].includes(flag)||argv.length!==2)throw Error('Use an exact group/suite; no grep, project, retry or timeout overrides.');
const value=argv[1],selected=flag==='--suite'?manifest.groups.filter(g=>g.suite==='test:playwright:'+value):manifest.groups.filter(g=>g.name===value);
if(!selected.length)throw Error('Unknown browser group or suite.');
if(!/^v24\.18\./.test(process.version))throw Error('Use supported Node24.18.');
const safe=['HOME','PATH','USER','TMPDIR','TEMP','TMP','LANG','LC_ALL','CI','GITHUB_ACTIONS','GITHUB_RUN_ID','GITHUB_JOB','PLAYWRIGHT_BROWSERS_PATH'];
async function run(group){
 const baseOutput=process.env.LPC_BROWSER_ACCEPTANCE_OUTPUT||path.join(backend,'test-results/critical');
 const output=path.join(baseOutput,group.name);fs.mkdirSync(output,{recursive:true});
 const locks=[];
 try{
  for(const resource of group.resourceLocks){
   const lock=path.join(os.tmpdir(),'lpc-browser-resource-'+resource+'.lock');
   try{const fd=fs.openSync(lock,'wx',0o600);fs.writeFileSync(fd,JSON.stringify({pid:process.pid,group:group.name}));fs.closeSync(fd);locks.push(lock);}
   catch(error){if(error.code!=='EEXIST')throw error;throw Error('Another local browser group holds '+resource+'; stagger these groups, do not share the server.');}
  }
  const env={...Object.fromEntries(safe.filter(k=>process.env[k]).map(k=>[k,process.env[k]])),
   NODE_ENV:'test',APP_ENV:'test',EMAIL_DISABLE:'true',OPENAI_API_KEY:'',
   AWS_EC2_METADATA_DISABLED:'true',AWS_CONFIG_FILE:'/dev/null',AWS_SHARED_CREDENTIALS_FILE:'/dev/null',
   JWT_SECRET:crypto.randomBytes(48).toString('hex'),DATA_ENCRYPTION_KEY:'0123456789abcdef'.repeat(4),
   MONGOMS_IP:'127.0.0.1',MONGOMS_VERSION:'8.0.34',
   ...(process.env.CI?{}:{MONGOMS_RUNTIME_DOWNLOAD:'false'}),
   LPC_BROWSER_GROUP:group.name,LPC_BROWSER_GROUP_OUTPUT:output,
   LPC_TEST_MONGO_NAMESPACE:'browser-'+group.name+'-'+process.pid,
   LPC_LIFECYCLE_RANDOM_PORT:'true',LPC_ADMIN_LEGACY_PORT:'0',
   LPC_USE_BUILT_FRONTEND:'true',LPC_SECURITY_FRONTEND_ROOT:path.resolve(backend,'../.lpc-build/frontend'),
   ...group.environment};
  const command=[path.join(backend,'node_modules/playwright/cli.js'),'test','-c',path.join(backend,'tests/playwright/acceptance/group.config.cjs'),'--fail-on-flaky-tests',...(flag==='--collect-group'?['--list','--reporter=json']:[])];
  return await new Promise((resolve,reject)=>{
   const child=spawn(process.execPath,command,{cwd:backend,env,stdio:'inherit'});
   const stop=()=>child.kill('SIGTERM');process.once('SIGINT',stop);process.once('SIGTERM',stop);
   child.once('error',reject);child.once('close',(code,signal)=>{
    process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);
    if(flag!=='--collect-group'&&code===0&&!signal){
     try{
      const report=JSON.parse(fs.readFileSync(path.join(output,'results.json'))),stats=report.stats;
      if(stats.expected!==group.expectedIdentities||stats.unexpected!==0||stats.skipped!==0||stats.flaky!==0||report.errors?.length)throw Error('Incomplete, skipped or unsuccessful browser identities');
     }catch(error){console.error('Browser group '+group.name+' did not qualify: '+error.message);code=1;}
    }
    resolve({group:group.name,code,signal});
   });
  });
 }finally{for(const lock of locks)fs.unlinkSync(lock);}
}
(async()=>{for(const group of selected){const result=await run(group);if(result.code!==0||result.signal){process.exitCode=result.code||1;break;}}})().catch(error=>{console.error(error.message);process.exitCode=1;});
