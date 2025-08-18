import { initSupabase, supa, USE_SUPABASE } from './supa.js';
import { escapeHTML } from './helpers.js';

const state = {
  user: JSON.parse(localStorage.getItem('currentUser')||'null'),
  job: null,
  sbUrl: '', sbKey: ''
};

const els = {
  loginWrap: document.getElementById('loginContainer'),
  app: document.getElementById('app'),
  loginForm: document.getElementById('loginForm'),
  username: document.getElementById('username'),
  role: document.getElementById('role'),
  sbUrl: document.getElementById('sbUrl'),
  sbKey: document.getElementById('sbKey'),
  logoutBtn: document.getElementById('logoutBtn'),
  jobTitle: document.getElementById('jobTitle'),
  jobStatus: document.getElementById('jobStatus'),
  content: document.getElementById('contentArea'),
  uploadBtn: document.getElementById('uploadBtn'),
  fileInput: document.getElementById('fileInput'),
  sidebarLinks: [...document.querySelectorAll('.sidebar a[data-route]')],
};

const defaultJobLocal = {
  id:'job-local-1', name:'Johnson v. Smith', status:'In Progress',
  participants:[{name:'Alice Paralegal',role:'paralegal'}],
  messages:[], checklist:[], deadlines:[], documents:[]
};

boot();

function boot() {
  els.loginForm.addEventListener('submit', onLogin);
  els.logoutBtn.addEventListener('click', onLogout);
  els.sidebarLinks.forEach(a => a.addEventListener('click', onRouteClick));
  els.uploadBtn.addEventListener('click', ()=>els.fileInput.click());
  els.fileInput.addEventListener('change', onUpload);

  if (state.user) initApp();
}

async function onLogin(e){
  e.preventDefault();
  const name = els.username.value.trim();
  if (!name) return;
  state.user = { name, role: els.role.value };
  localStorage.setItem('currentUser', JSON.stringify(state.user));

  state.sbUrl = els.sbUrl.value.trim();
  state.sbKey = els.sbKey.value.trim();
  initSupabase(state.sbUrl, state.sbKey);

  await initApp();
}

function onLogout(){
  localStorage.removeItem('currentUser');
  location.reload();
}

async function initApp(){
  els.loginWrap.classList.add('hidden');
  els.app.classList.remove('hidden');
  await ensureJob();
  els.jobTitle.textContent = `Active Job: ${state.job.name}`;
  els.jobStatus.textContent = state.job.status;
  routeTo(location.hash.replace('#','') || 'overview');
  window.addEventListener('hashchange', ()=>routeTo(location.hash.replace('#','')));
}

async function ensureJob(){
  if (USE_SUPABASE) {
    const { data: job } = await supa.from('jobs').select('*').ilike('name','Johnson v. Smith').maybeSingle();
    let j = job;
    if (!j) {
      const ins = await supa.from('jobs').insert({ name:'Johnson v. Smith', status:'In Progress' }).select().single();
      j = ins.data;
    }
    const { data: u } = await supa.from('users').select('*').eq('name', state.user.name).maybeSingle();
    let user = u;
    if (!user) {
      const insU = await supa.from('users').insert({ name: state.user.name, role: state.user.role }).select().single();
      user = insU.data;
    }
    await supa.from('job_participants').upsert({ job_id: j.id, user_id: user.id, role: user.role }, { onConflict: 'job_id,user_id' });
    state.job = j;
    state.userRow = user;
  } else {
    const local = JSON.parse(localStorage.getItem('jobData')||'null') || defaultJobLocal;
    localStorage.setItem('jobData', JSON.stringify(local));
    state.job = local;
  }
}

function onRouteClick(e){
  e.preventDefault();
  const route = e.currentTarget.dataset.route;
  location.hash = route;
}

function setActive(route){
  els.sidebarLinks.forEach(a => a.classList.toggle('active', a.dataset.route === route));
}

async function routeTo(route){
  if (!route) route = 'overview';
  setActive(route);
  const loader = {
    overview: () => import('./views/overview.js'),
    profile: () => import('./views/profile.js'),
    messages: () => import('./views/messages.js'),
    checklist: () => import('./views/checklist.js'),
    deadlines: () => import('./views/deadlines.js'),
    documents: () => import('./views/documents.js').catch(()=>({ render: el=>el.innerHTML='<div class="section"><div class="section-title">Documents</div><p>Coming soon</p></div>'})),
    calendar: () => import('./views/calendar.js'),
    settings: () => import('./views/settings.js').catch(()=>({ render: el=>el.innerHTML='<div class="section"><div class="section-title">Settings</div><p>Coming soon</p></div>'})),
    help: () => import('./views/help.js').catch(()=>({ render: el=>el.innerHTML='<div class="section"><div class="section-title">Help</div><p>Coming soon</p></div>'}))
  }[route];

  if (!loader) return routeTo('overview');

  const mod = await loader();
  await mod.render(els.content, { state, supa, USE_SUPABASE, escapeHTML });
}

function onUpload(e){
  const files = [...e.target.files];
  if (!files.length) return;
  alert('Document upload wiring is pending Supabase Storage hookup.');
  e.target.value = '';
}
