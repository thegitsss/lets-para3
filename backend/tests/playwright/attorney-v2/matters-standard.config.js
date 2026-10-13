const config=require('./playwright.config');
const path=require('node:path');
module.exports={...config,testMatch:['matters-standard.spec.js','matters-file-controls.spec.js','files-refresh.spec.js','work.spec.js'],reporter:'list',outputDir:path.resolve(__dirname,'../../../test-results/attorney-matters-standard')};
