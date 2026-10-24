const path=require('node:path');
const base=require('../financial-lifecycle/playwright.config');
module.exports={...base,testDir:__dirname,testMatch:/evidence\.spec\.js$/,reporter:[['list'],['json',{outputFile:process.env.LPC_EVIDENCE_REPORT||path.resolve(__dirname,'../../../test-results/admin-evidence/results.json')}]],outputDir:process.env.LPC_EVIDENCE_OUTPUT||path.resolve(__dirname,'../../../test-results/admin-evidence/browser')};
