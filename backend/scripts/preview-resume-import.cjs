'use strict';
// Run only on loopback. All account data and storage in this preview are synthetic.
process.env.NODE_ENV = 'test'; process.env.ENABLE_CSRF = 'false';
const express = require('express'), path = require('node:path');
const { createResumeImportRouter } = require('../routes/resumeImport');
const { extractFile } = require('../services/resumeImport');
const fixture = require('../tests/fixtures/resume-import/synthetic.cjs');
const app=express(); let user=fixture.user(); const counts={extracts:0,patches:0};
app.use(express.json({limit:'256kb'}));app.use((_req,res,next)=>{res.set('Cache-Control','no-store');next();});
app.get('/api/csrf',(_req,res)=>res.json({csrfToken:'synthetic-preview'}));
app.get('/api/auth/me',(_req,res)=>res.json({user}));
app.get('/api/account/preferences',(_req,res)=>res.json(user.preferences));
app.get('/api/users/me',(_req,res)=>res.json(user));
app.patch('/api/users/me',(req,res)=>{
  const {expectedOwnerId,expectedValues,...patch}=req.body;
  const allowed=['experience','education','skills','practiceAreas','languages','bio','linkedInURL'];
  if(expectedOwnerId!==fixture.ownerId||Object.keys(patch).some(k=>!allowed.includes(k)))return res.status(400).json({error:'This preview only saves résumé suggestions to synthetic in-memory data.'});
  if(Object.entries(expectedValues||{}).some(([key,value])=>JSON.stringify(user[key]??'')!==JSON.stringify(value??'')))return res.status(409).json({error:'Profile changed. Cancel and reopen Autofill.'});
  if(req.query.fail==='1')return res.status(503).json({error:'Synthetic save failure.'});
  counts.patches++;user={...user,...patch};if('bio'in patch)user.about=patch.bio;if('practiceAreas'in patch)user.specialties=patch.practiceAreas;res.json(user);
});
app.use('/api/users/me/resume-import',(req,_res,next)=>{req.user={id:fixture.ownerId,role:'paralegal'};next();},createResumeImportRouter({authorize:[],enabled:()=>true,rateLimitMax:1000,loadExisting:async()=>({buffer:fixture.pdf(),mimetype:'application/pdf',originalname:'synthetic.pdf'}),extract:async(file,options)=>{counts.extracts++;return extractFile(file,options);}}));
app.get('/synthetic-resume.txt',(_req,res)=>res.type('text/plain').send(fixture.text));
app.get('/synthetic-resume.doc',(_req,res)=>res.type('application/msword').sendFile(path.resolve(__dirname,'../tests/fixtures/resume-import/synthetic.doc')));
app.get('/synthetic-resume.docx',(_req,res)=>res.type('application/vnd.openxmlformats-officedocument.wordprocessingml.document').sendFile(path.resolve(__dirname,'../tests/fixtures/resume-import/synthetic.docx')));
app.get('/synthetic-resume.pdf',(_req,res)=>res.type('application/pdf').send(fixture.pdf()));
app.get('/preview-state',(_req,res)=>res.json({user,counts}));
app.post('/preview-reset',(req,res)=>{user=fixture.user(req.body.empty===true);if(req.body.noResume)user.resumeURL='';counts.extracts=counts.patches=0;res.json({ok:true});});
app.get('/',(_req,res)=>res.type('html').send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>LPC · Résumé Autofill preview</title><link rel="stylesheet" href="/assets/styles/fonts.css"><link rel="stylesheet" href="/assets/styles/paralegal-v2.css"><link rel="stylesheet" href="/assets/styles/paralegal-v2-settings.css"><link rel="stylesheet" href="/assets/styles/paralegal-v2-visual.css"><link rel="stylesheet" href="/assets/styles/resume-import.css"><style>body.lpc-v2{overflow:auto;height:auto}.preview-note{padding:12px 24px;background:var(--v2-soft);font-size:14px}main{max-width:1050px;margin:auto;padding:24px}.preview-note a{color:var(--v2-blue)}#toast{position:fixed;bottom:12px;left:16px;right:16px;background:var(--v2-soft);padding:12px;z-index:5}#toast:empty{display:none}</style></head><body class="lpc-v2"><div class="preview-note">Local review · synthetic account · real local PDF/Word extraction · no external AI calls.<br>Use synthetic files only. <a href="/synthetic-resume.pdf" download>Sample PDF</a> · <a href="/synthetic-resume.doc" download>Sample DOC</a> · <a href="/synthetic-resume.docx" download>Sample DOCX</a> · <a href="/?intro=1">Replay welcome popup</a></div><main id="app"></main><div id="toast" role="status"></div><script type="module">
import {createSettingsView} from '/assets/scripts/paralegal-v2/settings-view.mjs';
import {createApiClient} from '/assets/scripts/paralegal-v2/api-client.mjs';
const identity=(await fetch('/api/auth/me').then(r=>r.json())).user;
// Explicit review link only; normal Profile dismissal behavior is unchanged.
if (new URLSearchParams(location.search).get('intro') === '1') {
  try { localStorage.removeItem('lpc_resume_intro_v1:' + identity._id); } catch {}
  history.replaceState(null, '', location.pathname);
}
const api=createApiClient();
const view=createSettingsView({api,getIdentity:()=>identity,showToast:message=>document.querySelector('#toast').textContent=message,updateIdentity:()=>{}});
const route={query:new URLSearchParams('tab=profile')};
document.querySelector('#app').append(await view.render({route,isCurrent:()=>true}));view.afterMount(route);
</script></body></html>`));
app.use(express.static(path.resolve(__dirname,'../../frontend'),{index:false}));
const server=app.listen(Number(process.env.LPC_RESUME_PREVIEW_PORT||5068),'127.0.0.1',()=>{if(server.address())console.log(`LPC synthetic résumé preview: http://127.0.0.1:${server.address().port}`);});
server.on('error',error=>{console.error(error.code);process.exitCode=1;});
