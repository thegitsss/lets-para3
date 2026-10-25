"use strict";
// Only synthetic Matter notes reach the configured AI provider. No application
// database, Stripe, storage, SMTP, or real-user data is loaded.
const fs=require('fs'),path=require('path'),assert=require('assert');
const configuration=require('dotenv').parse(fs.readFileSync(process.argv[2]));
for(const name of ['OPENAI_API_KEY','OPENAI_SUPPORT_MODEL','OPENAI_MODEL']) if(configuration[name])process.env[name]=configuration[name];
process.env.NODE_ENV='test';
const result={observedAt:new Date().toISOString(),provider:'configured OpenAI API',productionDatabaseAccess:false,syntheticInputOnly:true,configuredModel:process.env.OPENAI_SUPPORT_MODEL||process.env.OPENAI_MODEL||'default',verified:false};
(async()=>{
 const {suggestMatterDraft}=require('../../services/matterDraftSuggestions');
 const brief='Organize 12 synthetic exhibits into one PDF for attorney review. Do not add legal research. Flat budget $400. Need the work by March 14, 2027. California. Applicants must have 3 years of experience.';
 const draft=await suggestMatterDraft(brief,{practices:['Litigation'],state:'California'});
 result.draft=draft;
 assert.equal(Number(draft.compAmount),400);assert.equal(draft.deadline,'2027-03-14');assert.equal(draft.state,'California');assert.equal(draft.experience,'3+ years');assert.equal(draft.tasks.length,1);assert(draft.description.includes('12'));
 result.verified=true;result.draft=draft;result.boundaries=['structured schema','explicit budget','work deadline','state','experience','one requested deliverable','provider fidelity check'];
})().catch(error=>{result.error={status:error.status||null,code:error.code||null,name:error.name||'Error',validationFailure:error.name==='AssertionError',assertion:error.name==='AssertionError'?{actual:error.actual,expected:error.expected,operator:error.operator}:undefined};process.exitCode=1;}).finally(()=>{fs.writeFileSync(process.argv[3],JSON.stringify(result,null,2)+'\n',{mode:0o600});console.log(JSON.stringify({verified:result.verified,error:result.error||null}));});
