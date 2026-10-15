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


module.exports={prepare,ui,activeMatter,conversation,oldAnswer,oldUser,CONVERSATION};
