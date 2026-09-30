const path=require('path');
const {defineConfig}=require('playwright/test');
const {CURRENT_BROWSER_PROJECTS}=require('../../../playwright.browser-matrix');
module.exports=defineConfig({testDir:__dirname,testMatch:'blocked-real.spec.js',workers:1,fullyParallel:false,retries:0,timeout:90000,expect:{timeout:10000},reporter:[['list']],outputDir:path.resolve(__dirname,'../../../test-results/attorney-blocked-real'),projects:CURRENT_BROWSER_PROJECTS,use:{baseURL:'http://localhost:5293',headless:true,screenshot:'only-on-failure',trace:'retain-on-failure'}});
