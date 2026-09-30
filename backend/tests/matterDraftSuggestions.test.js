const request = require('supertest');
const express = require('express');
jest.mock('../ai/config', () => ({createStructuredResponse:jest.fn()}));
jest.mock('../utils/verifyToken', () => (req,res,next) => {if(!req.headers['x-test-user'])return res.sendStatus(401);req.user={id:req.headers['x-test-user'],role:req.headers['x-test-role']||'attorney'};next();});
jest.mock('../utils/authz', () => ({requireApproved:(_req,_res,next)=>next(),requireRole:()=> (req,res,next)=>req.user.role==='attorney'?next():res.sendStatus(403)}));
jest.mock('../utils/csrf', () => ({csrfProtection:(req,res,next)=>req.headers['x-test-csrf']?next():res.sendStatus(403)}));
jest.mock('../models/User',()=>({findById:jest.fn(()=>({select:()=>({lean:async()=>({practiceAreas:['Contract Law'],state:'NY'})})}))}));
const ai=require('../ai/config');
const app=express();app.use(express.json());app.use('/api/case-drafts',require('../routes/caseDrafts'));
const suggestion={title:'Contract review',practiceArea:'Contract Law',description:'Prepare a contract summary.',tasks:['Summarize key terms']};
let n=0;
const post=(body,headers={})=>request(app).post('/api/case-drafts/suggest').set({'x-test-user':String(++n),'x-test-csrf':'yes',...headers}).send(body);
const emptyDetails={compensation:null,deadline:null,state:null,experience:null,requirements:[]};
const faithful={unsupportedWorkOrFacts:false,omittedExplicitDetails:false,changedMeaning:false};
function mockSuggestion(value,verdict=faithful){ai.createStructuredResponse.mockImplementation(async options=>({data:options.textFormat.name==='matter_draft_fidelity'?verdict:{...value,details:{...emptyDetails,...value.details}}}));}
beforeEach(()=>ai.createStructuredResponse.mockReset());
test('leaves compensation and deadline absent when the request does not supply them',async()=>{
 mockSuggestion(suggestion);
 const res=await post({brief:'Help me summarize a contract.'});expect(res.status).toBe(200);expect(res.body).toEqual({suggestions:suggestion});
 expect(ai.createStructuredResponse.mock.calls[0][0].instructions).toContain('Do not invent');
});
test('rejects invalid input and account mismatch before calling AI',async()=>{
 for(const body of [{brief:'short'},{brief:'x'.repeat(4001)},{brief:'A valid work description',compAmount:'1000'},{brief:'A valid work description',expectedOwnerId:'someone-else'}])expect((await post(body)).status).toBe(body.expectedOwnerId?403:400);
 expect(ai.createStructuredResponse).not.toHaveBeenCalled();
});
test('requires authentication, role, and CSRF middleware',async()=>{
 expect((await request(app).post('/api/case-drafts/suggest').send({brief:'Describe contract work'})).status).toBe(401);
 expect((await post({brief:'Describe contract work'},{'x-test-role':'paralegal'})).status).toBe(403);
 expect((await request(app).post('/api/case-drafts/suggest').set('x-test-user','csrf-test').send({brief:'Describe contract work'})).status).toBe(403);
});
test('provider failures and invalid outputs fail without fabricated suggestions',async()=>{
 for(const value of [{...suggestion,compAmount:'900'},{...suggestion,practiceArea:'Invented law'},{...suggestion,tasks:[]}]){
 mockSuggestion(value);expect((await post({brief:'Describe contract work'})).status).toBe(503);
 }
 ai.createStructuredResponse.mockRejectedValue(Error('secret provider detail'));const res=await post({brief:'Describe contract work'});expect(res.status).toBe(503);expect(JSON.stringify(res.body)).not.toContain('secret');
});

test('profile defaults are owner-bound and normalize the bar state',async()=>{
 const res=await request(app).get('/api/case-drafts/defaults?expectedOwnerId=profile').set('x-test-user','profile');
 expect(res.status).toBe(200);expect(res.body).toMatchObject({practiceArea:'Contract Law',state:'New York'});
 expect((await request(app).get('/api/case-drafts/defaults?expectedOwnerId=other').set('x-test-user','profile')).status).toBe(403);
});
test('AI stays within profile practices but permits an explicit Matter override',async()=>{
 mockSuggestion({...suggestion,practiceArea:'Tax Law'});
 expect((await post({brief:'Help with a tax matter.'})).status).toBe(503);
 const res=await post({brief:'Help with a tax matter.',practiceArea:'Tax Law',state:'California'});
 expect(res.status).toBe(200);
 expect(ai.createStructuredResponse.mock.calls.findLast(([options])=>options.textFormat.name==='matter_draft_suggestions')[0].instructions).toContain('California');
 expect((await post({brief:'Help with a tax matter.',state:'Imaginary'})).status).toBe(400);
});

test('refinement includes only bounded draft content and preserves request context',async()=>{
 mockSuggestion(suggestion);
 const current={title:'Existing title',description:'Existing description',tasks:['Existing task']};
 expect((await post({brief:'Make this shorter please.',current})).status).toBe(200);
 expect(JSON.parse(ai.createStructuredResponse.mock.calls.findLast(([options])=>options.textFormat.name==='matter_draft_suggestions')[0].input)).toEqual({request:'Make this shorter please.',currentDraft:current});
 expect((await post({brief:'Make this shorter please.',current:{...current,compAmount:'900'}})).status).toBe(400);
 expect((await post({brief:'Make this shorter please.',current:{...current,description:'x'.repeat(4001)}})).status).toBe(400);
});

 test.each(['unsupportedWorkOrFacts','omittedExplicitDetails','changedMeaning'])('rejects generated content when fidelity review flags %s',async flag=>{
   mockSuggestion(suggestion,{...faithful,[flag]:true});
   const res=await post({brief:'prepare binder with tabs for litigation trial next wednesdayfor medmal'});
   expect(res.status).toBe(503);expect(res.body.suggestions).toBeUndefined();
   const audit=ai.createStructuredResponse.mock.calls[1][0];
   expect(JSON.parse(audit.input).request).toContain('next wednesday');
   expect(audit.instructions).toContain('turning trial timing into a work deadline');
 });
 test('fidelity verification fails closed on malformed or unavailable verification',async()=>{
   for(const audit of [{},null,{...faithful,extra:true}]){
     mockSuggestion(suggestion,audit);expect((await post({brief:'Prepare a contract summary.'})).status).toBe(503);
   }
   ai.createStructuredResponse.mockReset().mockResolvedValueOnce({data:{...suggestion,details:emptyDetails}}).mockRejectedValueOnce(Error('audit unavailable'));
   expect((await post({brief:'Prepare a contract summary.'})).status).toBe(503);
 });

test('explicit compensation, work deadline and state are returned as editable draft fields',async()=>{
 const brief='prep supporting docs for trial in ca. need by april 1. compensation is 500.';
 mockSuggestion({...suggestion,details:{compensation:{amount:'500',source:'compensation is 500'},deadline:{text:'april 1',source:'need by april 1'},state:{text:'ca',source:'trial in ca'}}});
 const res=await post({brief});expect(res.status).toBe(200);
 const {resolveDeadline}=require('../services/matterDraftDetails');
 expect(res.body.suggestions).toMatchObject({compAmount:'500.00',deadline:resolveDeadline('april 1'),state:'California'});
 expect(res.body.suggestions.details).toBeUndefined();
});
test('unsupported source quotes cannot fill practical fields',async()=>{
 mockSuggestion({...suggestion,details:{compensation:{amount:'500',source:'compensation is 500'},deadline:{text:'April 1',source:'need by April 1'},state:{text:'ca',source:'trial in ca'}}});
 const res=await post({brief:'Prepare a contract summary.'});expect(res.status).toBe(200);expect(res.body.suggestions).toEqual(suggestion);
});

test('explicit need-by deadline is recovered when the generator omits it and is included in fidelity review',async()=>{
 mockSuggestion({...suggestion,description:'Prepare supporting docs for trial in California. Need by April 1; compensation is $500.'});
 const res=await post({brief:'prep supporting docs for trial in ca. need by april 1. compensation is 500.'});
 expect(res.status).toBe(200);
 expect(res.body.suggestions.deadline).toBe(require('../services/matterDraftDetails').resolveDeadline('april 1'));
 const audit=ai.createStructuredResponse.mock.calls.find(([options])=>options.textFormat.name==='matter_draft_fidelity')[0];
 expect(JSON.parse(audit.input).proposal.details.deadline).toEqual({text:'april 1',source:'need by april 1'});
});
test('fidelity can reject a recovered deadline when the wider context makes it inappropriate',async()=>{
 mockSuggestion(suggestion,{...faithful,changedMeaning:true});
 expect((await post({brief:'Need by April 1. That is the trial date, not the work deadline.'})).status).toBe(503);
});

test.each([
 {text:'by april 1',source:'need by april 1'},
 {text:'2027-04-01',source:'need by april 1'},
 {text:'april 1',source:'april 1'},
])('normalizes or repairs a source-bound deadline detail before returning it',async deadline=>{
 mockSuggestion({...suggestion,details:{...emptyDetails,deadline}});
 const res=await post({brief:'prep supporting docs for trial in ca. need by april 1. compensation is 500.'});
 expect(res.status).toBe(200);
 expect(res.body.suggestions.deadline).toBe(require('../services/matterDraftDetails').resolveDeadline('april 1'));
});

test('maps a complete brief into fields while retaining quantities, exclusions and preferences in scope',async()=>{
 const brief='Summarize 1,200 pages of records in California. Need by April 1. Compensation is 500. At least 5 years experience required. Must know Clio. Excel preferred. Include page references. Do not contact the client.';
 const description='Summarize 1,200 pages of records with page references. Do not contact the client. Excel preferred. Need by April 1; compensation is $500.';
 mockSuggestion({...suggestion,description,tasks:['Summarize records with page references'],details:{compensation:{amount:'500',source:'Compensation is 500'},deadline:null,state:{text:'California',source:'records in California'},experience:{value:'5+ years',text:'5 years experience',source:'At least 5 years experience required'},requirements:[{text:'Clio',source:'Must know Clio'}]}});
 const res=await post({brief});expect(res.status).toBe(200);
 expect(res.body.suggestions).toMatchObject({description,compAmount:'500.00',state:'California',experience:'5+ years',requirements:['Clio'],deadline:require('../services/matterDraftDetails').resolveDeadline('April 1')});
 const audit=ai.createStructuredResponse.mock.calls.find(([options])=>options.textFormat.name==='matter_draft_fidelity')[0];
 expect(JSON.parse(audit.input).appliedFields).toMatchObject({experience:'5+ years',requirements:['Clio'],compAmount:'500.00'});
});

const updateFields={title:'My title',description:'My scope',tasks:['Prepare summary'],practiceArea:'Contract Law',state:'California',compAmount:'',deadline:'',experience:'',requirements:[]};
test('targeted updates return only affected fields and audit the real patch',async()=>{
 mockSuggestion({...suggestion,changedFields:['compAmount'],clearFields:[],details:{compensation:{amount:'750',source:'Budget is $750'}}});
 const res=await post({brief:'Prepare a summary. Budget is $750.',update:{previousSource:'Prepare a summary.',fields:updateFields}});
 expect(res.status).toBe(200);expect(res.body.suggestions).toEqual({changes:{compAmount:'750.00'}});
 const audit=JSON.parse(ai.createStructuredResponse.mock.calls[1][0].input);expect(audit.changes).toEqual({compAmount:'750.00'});expect(audit.fields.title).toBe('My title');expect(audit.previousSource).toBe('Prepare a summary.');
});
test('targeted updates reject unrelated or unsupported patches and malformed current fields',async()=>{
 mockSuggestion({...suggestion,changedFields:['title'],clearFields:[]},{...faithful,changedMeaning:true});
 expect((await post({brief:'Prepare a summary. Budget is $750.',update:{previousSource:'Prepare a summary.',fields:updateFields}})).status).toBe(503);
 mockSuggestion({...suggestion,changedFields:['deadline'],clearFields:[]});
 expect((await post({brief:'Prepare a summary.',update:{previousSource:'Prepare a summary.',fields:updateFields}})).status).toBe(503);
 expect((await post({brief:'Prepare a summary.',update:{previousSource:'Prepare a summary.',fields:{...updateFields,admin:true}}})).status).toBe(400);
});
test('targeted updates can explicitly remove a field without inventing a replacement',async()=>{
 mockSuggestion({...suggestion,changedFields:['deadline'],clearFields:['deadline']});
 const res=await post({brief:'Prepare a summary. Remove the deadline.',update:{previousSource:'Prepare a summary. Due April 1.',fields:{...updateFields,deadline:'2027-04-01'}}});
 expect(res.status).toBe(200);expect(res.body.suggestions).toEqual({changes:{deadline:''}});
});
