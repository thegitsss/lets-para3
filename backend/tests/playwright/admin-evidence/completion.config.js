const base=require('./playwright.config');
module.exports={...base,testMatch:/(?:evidence|correspondence|growth)\.spec\.js$/};
