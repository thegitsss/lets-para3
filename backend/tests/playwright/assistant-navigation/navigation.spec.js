const {expect}=require('playwright/test');
const {test}=require('./shell-fixture');
const {fixture,json,OWNER,MATTER,workspaceMatter}=require('./fixture');
const CONVERSATION='555555555555555555555555';
const conversation={id:CONVERSATION,status:'open',escalation:{requested:false}};
const oldUser={id:'666666666666666666666666',sender:'user',text:'My earlier private question',createdAt:'2026-09-09T10:00:00.000Z'};
const oldAnswer={id:'777777777777777777777777',sender:'assistant',text:'Earlier verified account guidance',metadata:{},createdAt:'2026-09-09T10:00:01.000Z'};
const FILE_ID="64b000000000000000000712";
function activeMatter(overrides = {}) {
  return {
    _id: MATTER,
    id: MATTER,
    title: "Assigned Matter",
    status: "in progress",
    practiceArea: "Civil Litigation",
    state: "New York",
    locationState: "New York",
    details: "Prepare, organize, and quality-check the verified discovery response set.",
    deadlineDate: "2026-09-12",
    hiredAt: "2026-08-29T14:00:00.000Z",
    archived: false,
    readOnly: false,
    paymentReleased: false,
    files: [{
      id: FILE_ID,
      original: "Interrogatory responses.pdf",
      size: 82000,
      uploadedAt: "2026-09-01T14:00:00.000Z",
      uploadedByRole: "paralegal",
      status: "pending_review",
      version: 2,
    }],
    matterExperience: {
      version: 1,
      header: {
        title: "Assigned Matter",
        status: { code: "in_progress", label: "In progress" },
        practiceArea: "Civil Litigation",
        deadline: "2026-09-12",
        relationship: "Assigned paralegal",
        attention: null,
        primaryAction: { code: "continue_work", label: "Continue work", tab: "work" },
      },
      sections: [
        { id: "overview", label: "Overview" },
        { id: "work", label: "Work" },
        { id: "files", label: "Files" },
        { id: "messages", label: "Messages" },
        { id: "activity", label: "Activity" },
        { id: "financials", label: "Payments" },
      ],
      overview: {
        summary: "Prepare, organize, and quality-check the verified discovery response set.",
        practiceArea: "Civil Litigation",
        jurisdiction: "New York",
        deadline: "2026-09-12",
        hiredAt: "2026-08-29T14:00:00.000Z",
        attorney: "Jordan Lee",
        paralegal: "Dana Young",
        paralegalId: OWNER,
        taskProgress: { completed: 1, total: 2 },
      },
      applications: null,
      work: {
        tasks: [{ title: "Draft responses", completed: true }, { title: "Prepare exhibits", completed: false }],
        readOnly: false,
        completed: 1,
        total: 2,
        withdrawal: { allowed: true, blockers: [], completedTaskCount: 1, totalTaskCount: 2, outcomeRequiresReview: true },
        dispute: { allowed: true, blockers: [] },
      },
      activity: [
        { code: "file", label: "File shared", at: "2026-09-01T14:00:00.000Z" },
        { code: "started", label: "Work started", at: "2026-08-29T14:00:00.000Z" },
      ],
      financials: {
        currency: "usd",
        status: "Funded",
        amounts: [{ code: "compensation", label: "Matter compensation", cents: 90000 }, { code: "paralegal_fee", label: "Platform fee", cents: 10800 }],
        note: "Amounts reflect the matter's saved financial record.",
      },
    },
    ...overrides,
  };
}

const ui=page=>({drawer:page.locator('#supportDrawer'),composer:page.locator('[data-support-textarea]'),thread:page.locator('[data-support-thread]'),status:page.locator('[data-support-status]')});
async function prepare(page,role,{hash='/help',history=[oldUser,oldAnswer],historyStatus=200}={}){
 const result=await fixture(page,role,{hash,setup:s=>{if(process.env.LPC_NAV_NARROW)s.user.preferences={theme:'dark',fontSize:'xl'};s.matterRespond=route=>json(route,role==="paralegal"?activeMatter():{...workspaceMatter(),id:MATTER});}});
 const calls=[];const state={history,historyStatus,restart:null,send:null};
 await page.evaluate(owner=>sessionStorage.setItem('lpc_support_session_user',owner),OWNER);
 await page.route('**/api/support/**',async route=>{
  const req=route.request(),url=new URL(req.url());calls.push({path:url.pathname,method:req.method(),query:Object.fromEntries(url.searchParams),body:req.postData()?req.postDataJSON():null});
  if(url.pathname==='/api/support/conversation')return json(route,{ok:true,conversation});
  if(url.pathname===`/api/support/conversation/${CONVERSATION}/messages`&&req.method()==='GET')return json(route,{ok:state.historyStatus===200,conversation,messages:state.history},state.historyStatus);
  if(url.pathname.endsWith('/restart'))return state.restart?state.restart(route):json(route,{ok:true,conversation:{...conversation,id:'888888888888888888888888'},messages:[]},201);
  if(url.pathname.endsWith('/messages')&&req.method()==='POST')return state.send?state.send(route):json(route,{ok:true,conversation,userMessage:{...oldUser,text:req.postDataJSON().text},assistantMessage:oldAnswer},201);
  return json(route,{ok:true});
 });
 const open=async()=>{await page.locator(role==='attorney'?'[data-av2-assistant]':'[data-v2-assistant-trigger]').click();await expect(ui(page).drawer).toHaveAttribute('aria-hidden','false');};
 return {...result,sessionState:result.state,state,calls,open};
}
async function restart(page){await page.getByRole('button',{name:'Open assistant options',exact:true}).click();await page.getByRole('menuitem',{name:'Start new conversation',exact:true}).click();}

const forbidden = role => [
 ["other-role", `/${role === "attorney" ? "paralegal" : "attorney"}-v2.html#/settings`],
 ["admin", "/admin-dashboard.html"], ["unknown", "/unknown-workspace.html"],
 ["encoded-admin", "/%61dmin-dashboard.html"], ["invalid-own-route", `/${role}-v2.html#/settings-extra`],
 ["invalid-Matter", "/case-detail.html?caseId=invalid"],
 ["external", "https://example.test/profile-settings.html"], ["protocol-relative", "//example.test/profile-settings.html"],
 ["javascript", "javascript:alert(1)"], ["data", "data:text/html,test"], ["mailto", "mailto:test@example.test/profile.html"],
 ["backslash", "/\\example.test/admin.html"],
];
function linkedMessage(label, href, mode, index = 0) {
 return {...oldAnswer,id:(1000+index).toString(16).padStart(24,"0"),text:mode === "inline" ? `[${label}](${href})` : "A suggested destination.",metadata:mode === "actions" ? {actions:[{label,href}]} : {}};
}
for (const role of ["attorney", "paralegal"]) for (const mode of ["actions", "inline"]) {
 test(`${role} ${mode} omit role-inappropriate unknown malformed and external destinations`, async ({page},info) => {
  const targets=forbidden(role);const {open}=await prepare(page,role,{history:targets.map(([label,href],index)=>linkedMessage(label,href,mode,index))});await open();await expect(ui(page).drawer).toHaveAttribute("aria-busy","false");
  const offered=await ui(page).thread.locator(mode === "actions" ? ".support-message-action" : ".support-inline-link").evaluateAll(els=>els.map(el=>({label:el.textContent,href:el.getAttribute("href")})));
  await info.attach("offered-destinations",{body:JSON.stringify({role,mode,targets,offered},null,2),contentType:"application/json"});expect(offered).toEqual([]);
 });
 test(`${role} ${mode} keep verified Matter Settings and Help navigation inside one drawer with visible focus`, async ({page},info) => {
  const paths=[['Open Matter',`/case-detail.html?caseId=${MATTER}&tab=overview`],['Open preferences','/profile-settings.html?tab=preferences'],['Open Help',role==='attorney'?'/help.html':'/paralegalhelp.html']];
  const {open,calls}=await prepare(page,role,{history:paths.map(([label,href],index)=>linkedMessage(label,href,mode,index))});await open();await expect(ui(page).drawer).toHaveAttribute('aria-busy','false');
  await page.evaluate(()=>{window.__auditDrawer=document.getElementById('supportDrawer');});await ui(page).composer.fill('Retained navigation follow-up');const states=[];
  for(const [index,[label]] of paths.entries()){
   const control=ui(page).thread.getByRole(mode==='actions'?'button':'link',{name:label,exact:true});await control.focus();await control.press('Enter');
   const hash=index===0?(role==='attorney'?`#/matters/${MATTER}/overview`:`#/matter/${MATTER}?tab=overview`):index===1?'#/settings?tab=preferences':'#/help';
   await expect.poll(()=>new URL(page.url()).pathname+new URL(page.url()).hash).toBe(`/${role}-v2.html${hash}`);
   if(index===0)await expect(page.getByRole('heading',{name:role==='attorney'?'Litigation review':'Assigned Matter',exact:true})).toBeVisible();
   if(index===1)await expect(page.getByRole(role==='attorney'?'link':'tab',{name:'Preferences',exact:true})).toBeVisible();
   if(index===2)await expect(page.getByRole('heading',{name:role==='attorney'?'Help for Attorneys':'Help for Paralegals',exact:true})).toBeVisible();
   await expect(ui(page).drawer).toHaveAttribute('aria-hidden','false');await expect(ui(page).composer).toHaveValue('Retained navigation follow-up');
   const focus=await page.evaluate(()=>{const el=document.activeElement,r=el.getBoundingClientRect();return{tag:el.tagName,label:el.textContent?.slice(0,120),inside:Boolean(el.closest('#supportDrawer')),visible:r.bottom>0&&r.top<innerHeight&&r.right>0&&r.left<innerWidth,sameDrawer:window.__auditDrawer===document.getElementById('supportDrawer')};});states.push({label,...focus});await info.attach(`navigation-focus-${index}`,{body:JSON.stringify({label,...focus},null,2),contentType:'application/json'});expect.soft(focus.inside).toBe(true);expect.soft(focus.visible).toBe(true);expect(focus.sameDrawer).toBe(true);
  }
  if(process.env.LPC_NAV_NARROW){await expect(page.locator('html')).toHaveClass(/theme-dark/);await page.screenshot({path:info.outputPath(`${role}-${mode}-narrow-dark-xl.png`)});const overflow=await page.evaluate(()=>({page:document.documentElement.scrollWidth-innerWidth,drawer:document.getElementById('supportDrawer').scrollWidth-document.getElementById('supportDrawer').clientWidth}));expect(overflow.page).toBeLessThanOrEqual(1);expect(overflow.drawer).toBeLessThanOrEqual(1);}
  expect(calls.filter(c=>c.path.endsWith('/restart'))).toEqual([]);await info.attach('navigation-focus',{body:JSON.stringify(states,null,2),contentType:'application/json'});
 });
}
for(const mode of ['actions','inline'])test(`Paralegal ${mode} cannot navigate to a generated admin destination`,async({page},info)=>{
 const {open}=await prepare(page,'paralegal',{history:[linkedMessage('Open admin','/admin-dashboard.html',mode)]});await page.route('**/admin-dashboard.html',route=>route.fulfill({status:200,contentType:'text/html',body:'<!doctype html><p>Outside V2 fixture destination</p>'}));await open();await expect(ui(page).drawer).toHaveAttribute('aria-busy','false');const control=ui(page).thread.getByRole(mode==='actions'?'button':'link',{name:'Open admin',exact:true});
 if(await control.count()){await control.click();await expect.poll(()=>new URL(page.url()).pathname).not.toBe('/paralegal-v2.html');}
 await info.attach('actual-location',{body:page.url(),contentType:'text/plain'});expect(new URL(page.url()).pathname).toBe('/paralegal-v2.html');
});
for(const role of ['attorney','paralegal'])for(const cached of [false,true])test(`${role} authoritative dark XL preferences restore with ${cached?'cached light':'no cached'} identity`,async({page},info)=>{
 if(cached)await page.addInitScript(({owner,role})=>localStorage.setItem('lpc_user',JSON.stringify({id:owner,_id:owner,role,status:'approved',preferences:{theme:'light',fontSize:'md'}})),{owner:OWNER,role});
 await fixture(page,role,{hash:'/help',setup:state=>{state.user.preferences={theme:'dark',fontSize:'xl'};}});
 const rendered=await page.evaluate(()=>({theme:document.documentElement.className,font:getComputedStyle(document.documentElement).fontSize,cached:JSON.parse(localStorage.getItem('lpc_user')||'null')?.preferences}));await info.attach('rendered-preferences',{body:JSON.stringify(rendered,null,2),contentType:'application/json'});await page.screenshot({path:info.outputPath(`${role}-${cached?'cached-light':'fresh'}-server-dark-xl.png`)});
 expect.soft(rendered.theme).toContain('theme-dark');expect.soft(Number.parseFloat(rendered.font)).toBe(role==='paralegal'?22:20);expect(rendered.cached).toMatchObject({theme:'dark',fontSize:'xl'});
});

for(const role of ['attorney','paralegal'])test(`${role} Help launcher uses the same permitted navigation contract`,async({page})=>{
 await prepare(page,role,{history:[linkedMessage('Open admin','/admin-dashboard.html','actions'),linkedMessage('Open preferences','/profile-settings.html?tab=preferences','inline',1)]});
 await page.getByRole('button',{name:'Ask LPC Assistant',exact:true}).click();
 await expect(ui(page).drawer).toHaveAttribute('aria-busy','false');await expect(ui(page).drawer).toHaveAttribute('aria-hidden','false');
 await expect(ui(page).thread.getByRole('button',{name:'Open admin',exact:true})).toHaveCount(0);
 await ui(page).thread.getByRole('link',{name:'Open preferences',exact:true}).click();
 await expect(page).toHaveURL(new RegExp(`${role}-v2.html#/settings\\?tab=preferences$`));
 await expect(ui(page).drawer).toHaveAttribute('aria-hidden','false');
});

test('Paralegal verified appearance restores every existing reading size and theme alias',async({page},info)=>{
 const {state}=await fixture(page,'paralegal');const captures=[];
 for(const [size,pixels] of Object.entries({xs:15,sm:16,md:17,lg:20,xl:22})){
  state.user.preferences={theme:size==='md'?'light':'mountain-dark',fontSize:size};await page.reload();await expect(page.locator('body')).toHaveAttribute('data-v2-session','ready');
  await expect(page.locator('html')).toHaveClass(new RegExp(size==='md'?'theme-light':'theme-dark'));
  await expect.poll(()=>page.evaluate(()=>getComputedStyle(document.documentElement).fontSize)).toBe(`${pixels}px`);
  captures.push(await page.evaluate(()=>({theme:document.documentElement.className,font:getComputedStyle(document.documentElement).fontSize})));
 }
 await info.attach('all-saved-appearance-values',{body:JSON.stringify(captures,null,2),contentType:'application/json'});
});

test('Paralegal unchanged verified preferences preserve a selection while its save is pending',async({page},info)=>{
 const {state}=await fixture(page,'paralegal',{hash:'/settings?tab=preferences'});
 for(const [key,value] of [['theme','dark'],['fontSize','xl']]){
  let release;const hold=new Promise(resolve=>{release=resolve;});let received=0;
  state.preferenceRespond=async route=>{received++;await hold;state.user.preferences={...state.user.preferences,[key]:value};return json(route,{success:true,preferences:state.user.preferences});};
  if(key==='theme')await page.getByRole('radio',{name:'Dark',exact:true}).click();else await page.getByLabel('Font size',{exact:true}).selectOption(value);
  await expect.poll(()=>received).toBe(1);
  const count=()=>state.calls.filter(call=>call.path==='/api/auth/me').length;const before=count();
  await page.evaluate(()=>window.dispatchEvent(new Event('online')));await expect.poll(count).toBeGreaterThan(before);
  await expect(page.locator('body')).toHaveAttribute('data-v2-session','ready');
  await expect(page.locator('html')).toHaveClass(/theme-dark/);
  if(key==='fontSize')await expect.poll(()=>page.evaluate(()=>getComputedStyle(document.documentElement).fontSize)).toBe('22px');
  release();await expect(page.getByText(key==='theme'?'Appearance saved':'Reading size saved',{exact:true})).toBeVisible();
  expect(received).toBe(1);
 }
 await page.reload();await expect(page.locator('body')).toHaveAttribute('data-v2-session','ready');await expect(page.locator('html')).toHaveClass(/theme-dark/);await expect.poll(()=>page.evaluate(()=>getComputedStyle(document.documentElement).fontSize)).toBe('22px');
 await info.attach('confirmed-save-count',{body:JSON.stringify(state.calls.filter(call=>call.path==='/api/account/preferences'&&call.method==='POST')),contentType:'application/json'});
});

test('Attorney ordinary keyboard navigation still moves focus to the new route after Assistant closes',async({page})=>{
 const {open}=await prepare(page,'attorney');await open();await expect(ui(page).drawer).toHaveAttribute('aria-busy','false');
 await page.getByRole('button',{name:'Close assistant',exact:true}).click();
 const link=page.locator('[data-av2-route="settings"]');await link.focus();await link.press('Enter');
 await expect(page).toHaveURL(/#\/settings$/);await expect(page.locator('[data-av2-outlet]')).toBeFocused();
});
