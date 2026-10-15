const base=require('./playwright.config');
const {buildPlaywrightReporters}=require('../../../playwright.reporters');
module.exports={...base,testMatch:/(?:evidence|correspondence|growth)\.spec\.js$/,reporter:[...buildPlaywrightReporters('admin-evidence'),...base.reporter.filter(([name])=>name==='json')]};
