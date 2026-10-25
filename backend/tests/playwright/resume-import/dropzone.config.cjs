const path=require('node:path');const base=require('./playwright.config.cjs');
module.exports={...base,testMatch:['dropzone.spec.cjs','import.spec.cjs'],reporter:[['list'],['json',{outputFile:path.resolve(__dirname,'../../../../output/resume-import-dropzone-20261015/browser-results.json')}]],outputDir:path.resolve(__dirname,'../../../../output/resume-import-dropzone-20261015/browser-artifacts')};
