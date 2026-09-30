const { test } = require('../assistant-completion/shell-fixture');
const { fixture: shell, json, OWNER, MATTER } = require('../assistant-completion/fixture');
const { expect } = require('playwright/test');
const AxeBuilder = require('@axe-core/playwright').default;
const fs = require('node:fs');
const { assertApplicationFiltersReadable } = require('./application-filter-layout');
const CASE = MATTER, id = n => n.toString(16).padStart(24, '0');
const panel = page => page.locator('[data-matter-applications]');
const ready = page => expect(panel(page)).toHaveAttribute('data-state', 'ready');
const rows = page => panel(page).locator('[data-application]');
const statuses = ['submitted','viewed','shortlisted','accepted','rejected','withdrawn','unknown'];
function dataSet() { return Array.from({length:61},(_,i)=>({applicantId:id(i+1),applicationId:id(i+1001),name:`Applicant ${String(i+1).padStart(3,'0')}`,status:i%2?'submitted':'withdrawn',matterStatus:null,appliedAt:new Date(Date.UTC(2026,0,i+1)).toISOString(),withdrawnAt:null,profileAvailable:true,blocked:false,assigned:false,starred:i===4,resumeRecorded:false,linkedInRecorded:false,coverLetter:`Recorded letter ${i+1}`,profileSnapshot:null,history:[],invitations:[],warnings:[]})); }
function response(data, query) {
 const filters={page:Number(query.get('page')||1),sort:query.get('sort')||'newest',status:query.get('status')||'all',search:query.get('q')||'',applicantId:query.get('applicantId')||''};
 const counts=Object.fromEntries(statuses.map(key=>[key,data.filter(item=>item.status===key).length]));
 const filtered=data.filter(item=>filters.applicantId?item.applicantId===filters.applicantId:(filters.status==='all'||item.status===filters.status)&&item.name.toLowerCase().includes(filters.search.toLowerCase()));
 filtered.sort((a,b)=>filters.sort==='name'?a.name.localeCompare(b.name):filters.sort==='oldest'?a.appliedAt.localeCompare(b.appliedAt):filters.sort==='starred'&&a.starred!==b.starred?Number(b.starred)-Number(a.starred):b.appliedAt.localeCompare(a.appliedAt));
 const page=filters.applicantId?1:filters.page;
 return {ownerId:OWNER,caseId:CASE,caseTitle:'Contract application review',caseStatus:'open',archived:false,selectedApplicantId:filters.applicantId||null,filters,counts,page,pageSize:25,total:filtered.length,pages:Math.max(1,Math.ceil(filtered.length/25)),complete:true,warnings:[],revision:'e'.repeat(64),applications:filtered.slice((page-1)*25,page*25)};
}
async function install(page, hash=`/matters/${CASE}/applications`) {
 const state={data:dataSet(),calls:[],errors:[],status:200,transform:value=>value,respond:null};
 page.on('pageerror',error=>state.errors.push(error.message));
 await shell(page,'attorney',{hash,setup:async account=>{
  account.user.onboarding.attorneyTourCompleted=true;
  await page.route(`**/api/cases/${CASE}/application-inventory?**`,async route=>{
   const query=new URL(route.request().url()).searchParams;state.calls.push(Object.fromEntries(query));
   if(state.respond)return state.respond(route,query);
   return json(route,state.transform(response(state.data,query)),state.status);
  });
 }});
 await ready(page);return state;
}
test('complete counts and older pages survive refresh reload Back and exact selected-profile return links',async({page})=>{
 const list='#/matters?view=applications&q=Contract&page=2';
 const state=await install(page,`/matters/${CASE}/applications?${new URLSearchParams({returnTo:list})}`);
 await expect(rows(page)).toHaveCount(25);await expect(panel(page)).toContainText('1–25 of 61 applications');
 await panel(page).getByRole('button',{name:'Next applications',exact:true}).click();await ready(page);await expect(page).toHaveURL(/appPage=2/);
 await expect(rows(page).first()).toHaveAttribute('data-application',id(36));
 await panel(page).getByRole('button',{name:'Refresh applications'}).click();await ready(page);await expect(rows(page).first()).toHaveAttribute('data-application',id(36));
 await page.reload();await ready(page);await expect(rows(page).first()).toHaveAttribute('data-application',id(36));
 await rows(page).first().locator('summary').click();
 const href=await rows(page).first().getByRole('link',{name:'View current profile and documents',exact:true}).getAttribute('href');
 const back=new URLSearchParams(href.split('?')[1]).get('returnTo');expect(back).toContain('appPage=2');expect(back).toContain('applicantId='+id(36));expect(new URLSearchParams(back.split('?')[1]).get('returnTo')).toBe(list);
 await page.evaluate(hash=>{location.hash=hash;},back);await ready(page);await expect(rows(page)).toHaveCount(1);await expect(rows(page)).toHaveAttribute('open','');
 await panel(page).getByRole('button',{name:'Return to all applications'}).click();await ready(page);await expect(rows(page)).toHaveCount(25);await expect(rows(page).first()).toHaveAttribute('data-application',id(36));
 await panel(page).getByRole('button',{name:'Next applications',exact:true}).click();await ready(page);await expect(rows(page)).toHaveCount(11);await expect(panel(page)).toContainText('51–61 of 61 applications');
 await page.goBack();await ready(page);await expect(rows(page)).toHaveCount(25);
 expect(state.calls.every(call=>call.expectedOwnerId===OWNER)).toBe(true);expect(state.errors).toEqual([]);
});
test('search status and sort apply to older inventory and persist across reload without duplicate input labels',async({page})=>{
 await install(page);
 await panel(page).getByRole('combobox',{name:'Sort',exact:true}).selectOption('oldest');
 await panel(page).getByRole('combobox',{name:'Status',exact:true}).selectOption('withdrawn');
 await panel(page).getByRole('searchbox',{name:'Applicant name',exact:true}).fill('Applicant 00');
 await panel(page).getByRole('button',{name:'Apply filters'}).click();await ready(page);
 await expect(rows(page)).toHaveCount(5);await expect(rows(page).first()).toHaveAttribute('data-application',id(1));
 await page.reload();await ready(page);await expect(panel(page).getByRole('searchbox')).toHaveValue('Applicant 00');await expect(panel(page).getByRole('searchbox')).not.toHaveAttribute('placeholder',/./);
 await expect(panel(page).getByRole('combobox',{name:'Status',exact:true})).toHaveValue('withdrawn');
 await panel(page).getByRole('button',{name:'Clear filters'}).click();await ready(page);await expect(rows(page)).toHaveCount(25);
});
test('failed changed malformed and disappearing pages remove old records and counts while keeping filter drafts usable',async({page})=>{
 const state=await install(page);const search=panel(page).getByRole('searchbox');await search.fill('Unsaved filter');
 state.status=503;await panel(page).getByRole('button',{name:'Refresh applications'}).click();await expect(panel(page)).toHaveAttribute('data-state','error');
 await expect(rows(page)).toHaveCount(0);await expect(search).toHaveValue('Unsaved filter');await expect(panel(page)).not.toContainText('of 61');await expect(panel(page).getByRole('combobox',{name:'Status',exact:true})).not.toContainText('(61)');
 state.status=200;state.transform=value=>({...value,total:0});await panel(page).getByRole('button',{name:'Refresh applications'}).click();await expect(panel(page)).toHaveAttribute('data-state','error');
 state.transform=value=>value;await search.fill('');await panel(page).getByRole('button',{name:'Apply filters'}).click();await ready(page);
 await page.evaluate(id=>{location.hash=`/matters/${id}/applications?appPage=3`;},CASE);await ready(page);
 state.data=state.data.slice(0,2);await panel(page).getByRole('button',{name:'Refresh applications'}).click();await ready(page);await expect(rows(page)).toHaveCount(0);await expect(panel(page)).toContainText('This page no longer has applications');
 await panel(page).getByRole('button',{name:'Return to first page'}).click();await ready(page);await expect(rows(page)).toHaveCount(2);
});
test('a later filter request wins over delayed private records and page requests can be canceled',async({page})=>{
 const state=await install(page);let release,arrived;const gate=new Promise(resolve=>{release=resolve;}),waiting=new Promise(resolve=>{arrived=resolve;});
 state.respond=async(route,query)=>{const value=response(state.data,query);arrived();await gate;await json(route,value).catch(()=>{});};
 await panel(page).getByRole('button',{name:'Refresh applications'}).click();await waiting;
 state.respond=null;await panel(page).getByRole('searchbox').fill('Applicant 001');await panel(page).getByRole('button',{name:'Apply filters'}).click();await ready(page);release();
 await expect(rows(page)).toHaveCount(1);await expect(rows(page)).toHaveAttribute('data-application',id(1));await expect(panel(page)).not.toContainText('Recorded letter 61');expect(state.errors).toEqual([]);
});
test('empty incomplete filtered and unavailable states each have one clear outcome',async({page})=>{
 const state=await install(page);state.data=[];await panel(page).getByRole('button',{name:'Refresh applications'}).click();await ready(page);await expect(panel(page).getByText('No applications have been recorded for this Matter.',{exact:true})).toHaveCount(1);await expect(panel(page)).not.toContainText('0 applications');
 state.transform=value=>({...value,complete:false,warnings:['posting_missing']});await panel(page).getByRole('button',{name:'Refresh applications'}).click();await ready(page);await expect(panel(page)).toContainText('No readable applications');await expect(panel(page)).not.toContainText('No applications have been recorded');
 state.transform=value=>value;state.data=dataSet();await panel(page).getByRole('searchbox').fill('No match');await panel(page).getByRole('button',{name:'Apply filters'}).click();await ready(page);await expect(panel(page).getByText('No applications match these filters.',{exact:true})).toHaveCount(1);
});
test('application inventory stays contained accessible and uncluttered across themes widths and large text',async({page},testInfo)=>{
 const state=await install(page);const scans=[];
 for(const theme of ['light','dark'])for(const width of [320,390,1366]){
  await page.setViewportSize({width,height:900});await page.evaluate(theme=>document.documentElement.classList.toggle('theme-dark',theme==='dark'),theme);
  await page.locator('main').evaluate(node=>{node.scrollTop=0;});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
  for (const control of await panel(page).locator('form input, form select, form button:visible').all()) expect(Math.round((await control.boundingBox()).height * 1000) / 1000).toBeGreaterThanOrEqual(44);
  await assertApplicationFiltersReadable(panel(page));
  const result=await new AxeBuilder({page}).include('[data-matter-applications]').withTags(['wcag2a','wcag2aa','wcag21aa']).analyze();expect(result.violations).toEqual([]);scans.push({theme,width,violations:result.violations});
  await page.screenshot({path:testInfo.outputPath(`applications-${theme}-${width}.png`)});
 }
 await page.setViewportSize({width:390,height:900});await page.evaluate(()=>document.documentElement.style.fontSize='200%');
 for(const theme of ['light','dark']) {
  await page.evaluate(theme=>document.documentElement.classList.toggle('theme-dark',theme==='dark'),theme);
  await panel(page).getByRole('button',{name:'Apply filters'}).scrollIntoViewIfNeeded();expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
  const measurements=await assertApplicationFiltersReadable(panel(page));scans.push({theme,width:390,textScale:200,measurements});
  await page.screenshot({path:testInfo.outputPath(`applications-${theme}-large-text.png`)});
 }
 await rows(page).first().locator('summary').focus();await page.keyboard.press('Enter');await expect(rows(page).first()).toHaveAttribute('open','');
 await page.screenshot({path:testInfo.outputPath('applications-expanded-large-text.png')});
 fs.writeFileSync(testInfo.outputPath('accessibility.json'),JSON.stringify(scans,null,2));fs.writeFileSync(testInfo.outputPath('browser-errors.json'),JSON.stringify(state.errors));expect(state.errors).toEqual([]);
});
