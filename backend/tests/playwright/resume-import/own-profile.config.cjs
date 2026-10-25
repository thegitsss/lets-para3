const path=require('node:path');const base=require('./playwright.config.cjs');
module.exports={...base,testMatch:'own-profile.spec.cjs',reporter:[['list'],['json',{outputFile:path.resolve(__dirname,'../../../../output/resume-import-20261015/own-profile-results.json')}]],outputDir:path.resolve(__dirname,'../../../../output/resume-import-20261015/own-profile-artifacts')};
