'use strict';
const fs=require('node:fs'),path=require('node:path');
const backend=path.resolve(__dirname,'../../..');
const manifest=require('./groups.json');
const group=manifest.groups.find(g=>g.name===process.env.LPC_BROWSER_GROUP);
if(!group)throw Error('Select an exact approved browser group.');
const original=require(path.join(backend,group.baseConfig));
const output=path.resolve(process.env.LPC_BROWSER_GROUP_OUTPUT||path.join(backend,'test-results/critical',group.name));
fs.mkdirSync(output,{recursive:true});
Object.assign(process.env,group.environment,{
 LPC_LIFECYCLE_RANDOM_PORT:'true',LPC_ADMIN_LEGACY_PORT:'0',
 LPC_POSTING_BUSY_TEST_CANDIDATE:path.dirname(backend),
 LPC_HELP_SOURCE_ROOT:path.dirname(backend),
 LPC_POSTING_PUBLICATION_BROWSER_OUTPUT:output,LPC_PRIVATE_NOTES_BROWSER_OUTPUT:output,
 LPC_MATTER_NOTES_BROWSER_OUTPUT:output,LPC_SAVED_VIEWS_BROWSER_OUTPUT:output,
 LPC_WORKSPACE_BROWSER_OUTPUT:output,LPC_FINANCIAL_LOCAL_OUTPUT:output,
});
let webServer=original.webServer,use={...original.use},globalSetup=original.globalSetup,globalTeardown=original.globalTeardown;
if(group.adapter==='actual-shared'){
 // Existing real-owner fixtures own their authenticated session and HTTP app.
 // The published local adapter supplies one independent shared-Mongo lease.
 globalSetup=require.resolve('../../helpers/financialLifecycleGlobalSetup');
 globalTeardown=require.resolve('../../helpers/globalMongoTeardown');
 webServer=undefined;
 if(group.name==='paralegal-support-actual-shared-1')use.storageState={cookies:[],origins:[]};
}else if(webServer&&!['admin-financials','paralegal-financial-records'].includes(group.name)){
 const port=Number(process.env.LPC_BROWSER_HTTP_PORT||group.httpPort);
 if(!Number.isSafeInteger(port)||port<1024||port>65535||port===5054)throw Error('An independent loopback group port is required.');
 const origin=`http://127.0.0.1:${port}`;
 const originalMongoPort=String(webServer.env?.PLAYWRIGHT_MONGO_PORT||'');
 const retainedMongoPort=group.resourceLocks.includes('legacy-port-'+originalMongoPort)?originalMongoPort:'';
 process.env.PLAYWRIGHT_BASE_URL=origin;
 use.baseURL=origin;
 webServer={...webServer,port,reuseExistingServer:false,
  env:{...webServer.env,PORT:String(port),PLAYWRIGHT_BASE_URL:origin,
   APP_BASE_URL:origin,CLIENT_BASE_URL:origin,FRONTEND_BASE_URL:origin,
   PLAYWRIGHT_MONGO_PORT:retainedMongoPort,EMAIL_DISABLE:'true'}};
}
if(webServer&&typeof webServer.command==='string'&&webServer.command.replace(/\\/g,'/').includes('/control-room/webServer.js')){
 webServer={...webServer,gracefulShutdown:{signal:'SIGTERM',timeout:30000}};
}
module.exports={...original,
 testDir:path.join(backend,'tests/playwright'),
 testMatch:group.files.map(f=>path.join(backend,f)),
 workers:1,fullyParallel:false,retries:0,
 ...(group.timeoutMs?{timeout:group.timeoutMs}:{}),
 ...(group.expectMs?{expect:{...original.expect,timeout:group.expectMs}}:{}),
 globalSetup,globalTeardown,webServer,use:{...use,...(group.name==='financial-lifecycle'?{trace:'retain-on-failure'}:{})},
 reporter:[['list'],['json',{outputFile:path.join(output,'results.json')}],['junit',{outputFile:path.join(backend,'test-results/junit','critical-'+group.name+'.xml')}]],
 outputDir:path.join(output,'test-output'),
};
