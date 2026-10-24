import test from 'node:test';
import assert from 'node:assert/strict';
import {mergeSuggestions,resumeImportSnapshot} from '../../frontend/assets/scripts/paralegal-v2/resume-import-model.mjs';
const chosen=(field,value)=>({field,value,selected:true});
test('repeat imports deduplicate employment, education, language and skills across punctuation/case',()=>{
 const p={experience:[{title:'Paralegal | Example Legal',years:'2021–2024',description:'Current text'}],education:[{school:'Example College',degree:'B.A.'}],languages:[{name:'Spanish',proficiency:'Native'}],skills:['Legal Research']};
 const rows=[chosen('experience',{title:'paralegal | example legal',years:'2021-2024',description:'New text'}),chosen('education',{school:'example college',degree:'BA'}),chosen('languages',{name:'spanish',proficiency:''}),chosen('skills','legal research')];
 assert.deepEqual(mergeSuggestions(p,rows),{});assert.equal(p.experience[0].description,'Current text');
});
test('protects all saved values, including arrays beyond display limits',()=>{
 const entries=Array.from({length:31},(_,i)=>({title:`Role ${i}`,years:'',description:'Kept'}));const p=resumeImportSnapshot({experience:entries,skills:['A'],specialties:['Litigation']});
 assert.equal(p.experience.length,31);assert.deepEqual(p.practiceAreas,['Litigation']);assert.throws(()=>mergeSuggestions(p,[chosen('experience',{title:'New',years:'',description:''})]),/full/);assert.equal(p.experience.length,31);
});
test('unselected scalar conflicts and account authority fields never enter patch',()=>{
 const p=resumeImportSnapshot({bio:'Current',email:'owner@example.invalid'});assert.deepEqual(mergeSuggestions(p,[{field:'bio',value:'New',selected:false},chosen('email','other@example.invalid'),chosen('status','approved'),chosen('resumeURL','different'),chosen('yearsExperience',99)]),{});
 assert.deepEqual(mergeSuggestions(p,[chosen('bio','Reviewed new summary')]),{bio:'Reviewed new summary'});
});
test('deduplicates suggestions inside one import and rejects empty selected records',()=>{
 const p=resumeImportSnapshot({});assert.deepEqual(mergeSuggestions(p,[chosen('skills','Clio'),chosen('skills','clio')]),{skills:['Clio']});assert.throws(()=>mergeSuggestions(p,[chosen('education',{school:'',degree:''})]),/school/);assert.throws(()=>mergeSuggestions(p,[chosen('languages',{name:''})]),/name/);
});
test('respects existing five-skill limit without clearing current skills',()=>{
 const p=resumeImportSnapshot({skills:['A','B','C','D','E']});assert.throws(()=>mergeSuggestions(p,[chosen('skills','F')]),/full/);assert.deepEqual(p.skills,['A','B','C','D','E']);
});
