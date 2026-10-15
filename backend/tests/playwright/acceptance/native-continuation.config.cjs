'use strict';
const fs=require('node:fs'),path=require('node:path');
const backend=path.resolve(__dirname,'../../..'),scope=process.env.LPC_NATIVE_SCOPE;
if(!scope)throw Error('Exact continuation scope required');
const publicConfigs={'public-accessibility':'playwright.accessibility.config.js','public-performance':'playwright.performance.config.js'};
let base;if(publicConfigs[scope])base=require(path.join(backend,publicConfigs[scope]));else{process.env.LPC_BROWSER_GROUP=scope;base=require('./group.config.cjs');}
const output=path.resolve(process.env.LPC_NATIVE_OUTPUT||'');if(!process.env.LPC_NATIVE_OUTPUT)throw Error('Owned continuation output required');fs.mkdirSync(output,{recursive:true});
let webServer=base.webServer,use={...base.use};
if(publicConfigs[scope]&&webServer){const port=Number(process.env.LPC_NATIVE_PORT);if(!Number.isInteger(port)||port<1024||port>65535||[5054,5055].includes(port))throw Error('Distinct loopback port required');const origin='http://127.0.0.1:'+port;process.env.PLAYWRIGHT_BASE_URL=origin;use.baseURL=origin;webServer={...webServer,port,reuseExistingServer:false,command:webServer.command.replace(/PORT=\d+\s*/g,''),env:{...webServer.env,PORT:String(port),PLAYWRIGHT_BASE_URL:origin}};}
module.exports={...base,workers:1,fullyParallel:false,retries:0,forbidOnly:true,use,webServer,
 reporter:[['list'],['json',{outputFile:path.join(output,'results.json')}],['junit',{outputFile:path.join(output,'junit.xml')}]],outputDir:path.join(output,'test-output')};
