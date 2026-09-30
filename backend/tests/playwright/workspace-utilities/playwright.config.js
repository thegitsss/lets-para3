const path = require('node:path');
const { defineConfig } = require('playwright/test');
const output = path.resolve(__dirname, '../../../../outputs/checklist-execution-20260929/utilities');
module.exports = defineConfig({
  testDir:__dirname, workers:1, retries:0, timeout:45000, expect:{timeout:10000},
  projects:['chromium','firefox','webkit'].map(name=>({name,use:{browserName:name}})),
  use:{headless:true,serviceWorkers:'block',storageState:{cookies:[],origins:[]},screenshot:'only-on-failure',trace:'retain-on-failure'},
  reporter:[['list'],['json',{outputFile:path.join(output,'results.json')}]], outputDir:path.join(output,'artifacts'),
});
