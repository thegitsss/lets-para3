// Current, owner-verified workspace metrics only. Historical comparisons require
// an authoritative time-series source and are deliberately not synthesized.
export function renderMatterSummary({ model, node, link, shortDate }) {
  const el = (tag, className, text) => node(tag, { className, text });
  const active = model.activeWork;
  const dashboardReady = model.sources.dashboard.complete;
  const reviewsReady = model.workspace.reviewsComplete;
  const revisions = model.workspace.reviews.action;
  const invitations = model.opportunities.invitations;
  const applications = model.opportunities.applications;
  const overdue = active.filter(item => item.deadline && item.deadline < model.today);
  const deadlines = active.filter(item => item.deadline && item.deadline >= model.today).sort((a,b) => a.deadline.localeCompare(b.deadline));
  const knownProgress = dashboardReady && active.every(item => Number.isFinite(item.total) && Number.isFinite(item.completed));
  const total = knownProgress ? active.reduce((sum,item) => sum + item.total, 0) : null;
  const done = knownProgress ? active.reduce((sum,item) => sum + item.completed, 0) : null;
  const count = (ready, value) => ready ? String(value) : '—';
  const root = node('section', { className:'lpc-matter-summary', 'aria-label':'Matter summary' });
  root.append(node('header', {className:'lpc-summary-heading'}, [
    el('h1','','Matter summary'),
  ]));
  const date = new Intl.DateTimeFormat(undefined,{weekday:'short',month:'short',day:'numeric',timeZone:'America/New_York'}).format(new Date(`${model.today}T12:00:00Z`));
  const stats = node('dl',{className:'lpc-summary-today','aria-label':`Matter summary · ${date}`});
  [['Active Matters',count(dashboardReady,active.length),'Currently assigned'],['Next deadline',dashboardReady ? deadlines[0] ? shortDate(deadlines[0].deadline) : '—' : '—',dashboardReady ? deadlines[0]?.title || 'No upcoming Matter deadlines' : 'Could not load Matter deadlines'],['Past-due Matters',count(dashboardReady,overdue.length),'Based on recorded Matter deadlines']].forEach(([label,value,hint])=>stats.append(node('div',{},[el('dt','',label),node('dd',{},[el('span','',value),el('small','',hint)])])));
  root.append(node('div',{className:'lpc-summary-date'},[el('span','','Today'),el('time','',date)]),stats);
  root.append(node('header',{className:'lpc-summary-overview-heading'},[el('h2','','Your overview')]));
  const grid=node('div',{className:'lpc-summary-grid'});
  function card(title,value,ready,items,emptyText,href) {
    const panel=node('section',{className:'lpc-summary-card','aria-label':title},[node('h3',{},[link(title,href,'lpc-summary-card-link')]),el('strong','lpc-summary-value',count(ready,value))]);
    if(!ready) panel.append(el('p','lpc-summary-empty','Could not load this information.'));
    else if(items.length){const list=node('ul',{className:'lpc-summary-list'});items.slice(0,3).forEach(item=>list.append(node('li',{},[link(item.title,item.href,'lpc-summary-item'),item.detail?el('small','',item.detail):null])));panel.append(list);}
    else panel.append(el('p','lpc-summary-empty',emptyText));
    grid.append(panel);return panel;
  }
  card('Active Matters',active.length,dashboardReady,active.map(item=>({...item,detail:[item.attorney,item.label].filter(Boolean).join(' · ')})),'Assigned Matters will appear here.','/work?section=active');
  const progress=card('Work items complete',done,knownProgress,[],active.length ? `${done ?? '—'} of ${total ?? '—'} recorded work items complete.` : 'Work items will appear with your assigned Matters.','/home?view=insights');
  if(knownProgress && total>0){const meter=node('progress',{max:String(total),value:String(done),'aria-label':`${done} of ${total} work items complete`});progress.append(meter);}
  card('Upcoming deadlines',deadlines.length,dashboardReady,deadlines.map(item=>({...item,detail:shortDate(item.deadline)})),'No upcoming Matter deadlines.','/home?view=deadlines');
  card('Revisions requested',revisions.length,reviewsReady,revisions.map(item=>({...item,detail:item.contentTitle || item.reason || ''})),'No revisions need your attention.','/home?view=reviews');
  card('Pending applications',applications.length,model.sources.applications.complete,applications.map(item=>({...item,detail:item.label})),'No pending applications.','/work?section=applications');
  card('Invitations',invitations.length,model.sources.invites.complete,invitations.map(item=>({...item,detail:item.detail})),'No pending invitations.','/work?section=invitations');
  root.append(grid);return root;
}
