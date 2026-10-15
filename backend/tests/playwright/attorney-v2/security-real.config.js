const path=require('path');
const {defineConfig}=require('playwright/test');
const {CURRENT_BROWSER_PROJECTS}=require('../../../playwright.browser-matrix');
module.exports=defineConfig({
 testDir:__dirname,workers:1,fullyParallel:false,retries:0,timeout:90000,expect:{timeout:10000},
 reporter:[['list']],outputDir:path.resolve(__dirname,'../../../test-results/attorney-security-real'),
 // All shared account journeys run in every supported engine. CDP credential
 // automation is an additional Chromium capability; real-device coverage is separate.
 projects:CURRENT_BROWSER_PROJECTS.map(project=>({...project,testMatch:project.name==='chromium'
  ? ['security-real.spec.js','security-webauthn.chromium.spec.js'] : ['security-real.spec.js']})),
 use:{baseURL:'http://localhost:5289',headless:true,screenshot:'only-on-failure',trace:'retain-on-failure'},
});
