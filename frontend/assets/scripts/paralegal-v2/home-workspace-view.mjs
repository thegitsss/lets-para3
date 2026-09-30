import { filePreviewable, fileHref } from './matter-files.mjs';
import { WORK_TABS, chooseWorkTab } from './home-workspace-model.mjs';
import { newYorkDateOnly } from './home-model.mjs';
const ownId = value => String(value?._id || value?.id || value || '');
const values = value => Array.isArray(value) ? value : value?.items || [];
const workViews = new Set(['work','invitations','applications','recommendations']);
export function isWorkspaceView(view) { return workViews.has(view) || ['inbox','reviews','pulse'].includes(view); }
export function renderHomeWorkspace({ host, model, actions, node, link, button, shortDate }) {
  const state=actions.desktop, workspace=model.workspace;
  const isWork=workViews.has(state.view), isReviews=state.view==='reviews', isUpdates=state.view==='pulse';
  const view=isWork?'work':state.view, title=isWork?'My work':isReviews?'Reviews':isUpdates?'Updates':'Inbox';
  const availability=host.querySelector('[data-v2-availability-trigger]');
  const readiness=host.querySelector('.ph-readiness:not(.ph-profile-todos)');
  const el=(tag,cls,text)=>node(tag,{className:cls,text});
  let disposed=false, request=null, selectedVersion=0, rows=[], pane;
  const valid=()=>!disposed && actions.isValid();
  const control=(label,handler,cls='lc-button',attrs={})=>button(label,event=>{if(valid())handler(event);},cls,attrs);
  const icon=(shape='circle')=>{
    const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');svg.setAttribute('viewBox','0 0 24 24');svg.setAttribute('class','lc-icon');svg.setAttribute('aria-hidden','true');
    const p=document.createElementNS(svg.namespaceURI,'path');p.setAttribute('d',({circle:'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0',action:'M12 4v10m0 5h.01M3 3h18v18H3z',waiting:'M12 3a9 9 0 1 0 9 9M12 3v9h9',close:'m6 6 12 12M6 18 18 6',arrow:'m9 6 6 6-6 6',filter:'M4 6h16M7 12h10M10 18h4',file:'M6 3h8l5 5v13H6zM14 3v5h5M9 12h7M9 16h7'})[shape]||'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0');svg.append(p);return svg;
  };
  const tool=(label,shape,handler)=>{const b=control('',handler,'lc-tool v2-icon-button',{'aria-label':label,'data-tooltip':label});b.append(icon(shape));return b;};
  const date=value=>value ? shortDate(value).replace(/, \d{4}$/,'') : '';
  const timestamp=value=>value ? new Date(value).toLocaleString(undefined,{timeZone:'America/New_York',month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}) : '';
  const quiet=text=>el('p','lc-empty',text);
  host.classList.add('lc-workspace','ld-desktop');host.dataset.desktopView=state.view==='overview'?'work':state.view;host.dataset.workspaceView=view;
  host.replaceChildren();
  const stage=node('div',{className:'lc-stage'}), heading=node('header',{className:'lc-heading'},[node('h1',{text:title,tabindex:'-1'})]);
  if(isReviews) heading.append(link('Completed matters','/work?section=history','lc-history'));
  const tabs=node('div',{className:'lc-tabs',role:'tablist','aria-label':`${title} views`});
  const tools=node('div',{className:'lc-tools'});
  if(isUpdates && availability) tools.append(availability);
  const filter=tool('Filter records','filter',()=>{state.filterOpen=!state.filterOpen;filterRegion.hidden=!state.filterOpen;filter.setAttribute('aria-expanded',String(state.filterOpen));if(state.filterOpen)input.focus();});
  filter.setAttribute('aria-expanded',String(Boolean(state.filterOpen)));tools.append(filter);
  const toolbar=node('div',{className:'lc-toolbar'},[tabs,tools]);
  const input=node('input',{type:'search',value:state.search||'',placeholder:'Filter by title or context','aria-label':'Filter records'});
  const filterRegion=node('div',{className:'lc-filter',hidden:!state.filterOpen},[input]);
  const status=node('div',{className:'lc-source',role:'status',hidden:true});
  const body=node('div',{className:`lc-body ${isWork?'lc-work-body':'lc-event-body'}`});
  const list=node('section',{className:'lc-list',tabindex:'-1','aria-label':isWork?'Work records':`${title} records`,'data-home-desktop-list':''});
  body.append(list);stage.append(heading,toolbar,filterRegion,status,body);host.append(stage);
  const keepSelectedTabVisible=()=>{
    if(disposed || !tabs.isConnected)return;
    const selected=tabs.querySelector('[aria-selected="true"]');if(!selected)return;
    const frame=tabs.getBoundingClientRect(), active=selected.getBoundingClientRect();
    if(active.right>frame.right)tabs.scrollLeft+=active.right-frame.right;
    else if(active.left<frame.left)tabs.scrollLeft-=frame.left-active.left;
  };
  function keepSelectedRecordVisible(){
    if(!valid() || !state.selected || window.matchMedia('(max-width: 1100px)').matches)return;
    const selected=[...list.querySelectorAll('[data-desktop-record]')].find(item=>item.dataset.desktopRecord===state.selected);
    if(!selected)return;
    const frame=list.getBoundingClientRect(), item=selected.getBoundingClientRect();
    if(!frame.width || !frame.height)return;
    if(item.top<frame.top)list.scrollTop+=item.top-frame.top;
    else if(item.bottom>frame.bottom)list.scrollTop+=item.bottom-frame.bottom;
  }
  let measuredListWidth=null;
  const listObserver=new ResizeObserver(()=>{const width=list.clientWidth;if(measuredListWidth!==null && width!==measuredListWidth)keepSelectedRecordVisible();measuredListWidth=width;});listObserver.observe(list);
  const tabObserver=new ResizeObserver(keepSelectedTabVisible);tabObserver.observe(tabs);
  host.__workspaceDispose=()=>{disposed=true;selectedVersion++;request?.abort();tabObserver.disconnect();listObserver.disconnect();state.listScroll=list.scrollTop;};
  let tab=state.tab || (isWork?['invitations','applications','recommendations'].includes(state.view)?state.view:'':isReviews?'action':'all');
  if(isWork && !state.tab && state.selected) tab=state.selected.startsWith('application:')?'applications':state.selected.startsWith('invitation:')?'invitations':state.selected.startsWith('recommendation:')?'recommendations':tab;
  const initialSources=['dashboard','invites','applications','profile'];
  if(isWork && !state.tabChosen) {
    tab=chooseWorkTab(workspace,tab);
    if(initialSources.every(name=>model.sources[name].state!=='loading')) {state.tab=tab;state.tabChosen=true;}
  }
  const sourceName=()=>isWork?({work:'dashboard',invitations:'invites',applications:'applications',recommendations:'recommendations'})[tab]:isReviews?'submissions':'notifications';
  const tabItems=()=>isWork?WORK_TABS:isReviews?[['action','Needs your action'],['waiting','Awaiting attorney'],['history','History']]:[['all','All'],['unread','Unread']];
  function countFor(key) {
    if(isWork) {
      const source=model.sources[({work:'dashboard',invitations:'invites',applications:'applications',recommendations:'recommendations'})[key]];
      return source.complete?String(workspace.tabs[key].length):source.state==='loading'?'…':'?';
    }
    if(isReviews) return `${workspace.reviews[key].length}${workspace.reviewsComplete?'':'+'}`;
    return workspace.eventsComplete?String(key==='unread'?workspace.events.filter(e=>e.unread).length:workspace.events.length):'…';
  }
  function renderTabs(){
    tabs.replaceChildren(...tabItems().map(([key,label])=>{
      const b=control(' ',()=>{tab=key;state.tab=key;state.tabChosen=true;state.selected='';state.listScroll=0;closePane(false);renderTabs();renderList();tabs.querySelector(`[data-home-desktop-tab="${key}"]`)?.focus({preventScroll:true});},'lc-tab',{role:'tab','aria-selected':String(tab===key),tabindex:tab===key?'0':'-1','data-home-desktop-tab':key});
      b.replaceChildren(el('span','',label),el('span','lc-count',countFor(key)));
      if(key==='applications' && workspace.counts.requests) b.append(el('span','lc-context-count',`${workspace.counts.requests} need action`));
      b.addEventListener('keydown',event=>{if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;event.preventDefault();const items=[...tabs.children],at=items.indexOf(b);items[event.key==='Home'?0:event.key==='End'?items.length-1:(at+(event.key==='ArrowRight'?1:-1)+items.length)%items.length].focus();});return b;
    }));
    keepSelectedTabVisible();
  }
  function sourceStatus(){
    const source=model.sources[sourceName()], reviewIncomplete=isReviews&&!workspace.reviewsComplete;
    const otherFailures=isWork?WORK_TABS.filter(([key])=>key!==tab).filter(([key])=>{const source=model.sources[({work:'dashboard',invitations:'invites',applications:'applications',recommendations:'recommendations'})[key]];return !source.complete && source.state!=='loading';}).map(([,label])=>label):[];
    if(source?.complete&&!reviewIncomplete&&otherFailures.length){status.hidden=false;status.replaceChildren(el('span','',`${otherFailures.join(', ')} ${Object.values(model.sources).some(source=>source.state==='restricted')?'access is no longer available.':'records could not be loaded.'}`),control('Try again',actions.retry,'lc-link'));return;}
    if(source?.complete&&!reviewIncomplete&&((isReviews&&tab==='history')||(!isWork&&!isReviews&&workspace.events.length>=100))){status.hidden=false;status.replaceChildren(el('span','',isReviews?'Resolved submissions from your current matters.':'Showing the latest 100 recorded updates.'));return;}
    if(isWork&&source?.complete&&model.sources.dashboard.complete&&!workspace.reviewsComplete){
      const loading=model.sources.submissions.state==='loading';
      const restricted=workspace.reviewSources.some(source=>source.state==='restricted');
      status.hidden=false;status.replaceChildren(el('span','',loading?'Loading submission status…':restricted?'Access to some submission records is no longer available.':'Some submission records could not be verified. Review counts include only loaded records.'));
      if(!loading)status.append(control('Try again',actions.retry,'lc-link'));return;
    }
    const missing=!source?.complete || reviewIncomplete;
    status.hidden=!missing;
    if(missing) {const loading=source?.state==='loading';status.replaceChildren(el('span','',loading?'Loading records…':source?.state==='restricted'||reviewIncomplete&&workspace.reviewSources.some(source=>source.state==='restricted')?'Access to these records is no longer available.':reviewIncomplete?'Some submission records could not be verified. Counts include only loaded records.':'These records could not be loaded.'));if(!loading)status.append(control('Try again',actions.retry,'lc-link'));}
  }
  function recordButton(row){
    const selected=state.selected===row.key;
    const b=control('',()=>select(row),'lc-row ld-row',{'aria-label':`Preview ${row.title}${row.reason?': '+row.reason:''}`,'aria-pressed':String(selected),'data-desktop-record':row.key,[`data-home-${row.type}-id`]:row.id});
    b.append(icon(row.group==='Needs your action'||row.category==='action'?'action':row.category==='waiting'||row.group==='Waiting'?'waiting':'circle'));
    if(row.reference)b.append(el('span','lc-reference',row.reference));
    b.append(el('span','lc-record-title',row.title),el('span','lc-reason',row.reason || row.label || ''));
    if(row.deadline || row.matterDeadline)b.append(node('time',{className:'lc-date',datetime:row.deadline||row.matterDeadline,text:date(row.deadline||row.matterDeadline)}));
    b.append(icon('arrow'));return b;
  }
  function eventButton(row){
    const b=control('',()=>select(row),'lc-event ld-queue-row',{'aria-label':`Preview ${row.title}: ${row.reason}`,'aria-pressed':String(state.selected===row.key),'data-desktop-record':row.key});
    b.append(icon(row.type==='submission'?'file':'circle'),node('span',{className:'lc-event-copy'},[el('strong','',row.contentTitle||row.title),el('span','',row.type==='submission'?row.title:row.reason),node('span',{className:'lc-event-meta'},[row.actor?el('span','',row.actor):null,row.eventAt?node('time',{datetime:new Date(row.eventAt).toISOString(),text:timestamp(row.eventAt)}):null,row.unread?el('span','lc-unread','Unread'):null])]));return b;
  }
  function renderList(){
    const pos=list.scrollTop;
    rows=isWork?workspace.tabs[tab]||[]:isReviews?workspace.reviews[tab]||[]:workspace.events.filter(row=>tab!=='unread'||row.unread);
    rows=rows.filter(row=>!state.search||`${row.title} ${row.reason} ${row.contentTitle||''}`.toLowerCase().includes(state.search.toLowerCase()));
    list.replaceChildren();
    if(isWork && tab==='recommendations' && readiness) list.append(readiness);
    if(isWork && tab==='work'){
      for(const label of ['Needs your action','Active work','Waiting']){
        const group=rows.filter(row=>row.group===label);if(!group.length)continue;
        list.append(node('section',{className:'lc-group','aria-label':label},[node('header',{className:'lc-group-heading'},[el('h2','',label),el('span','lc-count',String(group.length))]),...group.map(recordButton)]));
      }
    } else if(isUpdates) {
      let last='';for(const row of rows){const day=row.eventAt?newYorkDateOnly(row.eventAt):'Date not recorded';if(day!==last){list.append(el('h2','lc-group-heading',day));last=day;}list.append(eventButton(row));}
    } else list.append(...rows.map(isWork?recordButton:eventButton));
    sourceStatus();
    const complete=model.sources[sourceName()]?.complete && (!isReviews||workspace.reviewsComplete) && (!(isWork&&tab==='work')||workspace.reviewsComplete);
    if(!rows.length)list.append(quiet(state.search?'No matching records.':complete?isReviews?'No submissions in this category.':isWork?'No records in this view.':'No recorded updates in this view.':'Records are unavailable.'));
    list.scrollTop=pos;
    if(state.selected && model.sources[sourceName()]?.complete && !rows.some(row=>row.key===state.selected)) {state.selected='';closePane(false);}
  }
  function updateSelection(){list.querySelectorAll('[data-desktop-record]').forEach(el=>el.setAttribute('aria-pressed',String(el.dataset.desktopRecord===state.selected)));}
  function closePane(restore=true){
    selectedVersion++;request?.abort();pane?.remove();pane=null;body.classList.remove('has-selection');const previous=state.selected;state.selected='';updateSelection();
    if(!isWork)body.append(pane=node('section',{className:'lc-context lc-context-empty'},[quiet(isReviews?'Select a submission to view its context.':'Select an update to view its context.')]));
    if(restore)[...list.querySelectorAll('[data-desktop-record]')].find(el=>el.dataset.desktopRecord===previous)?.focus({preventScroll:true});
  }
  function properties(row){
    const pairs=[['Status',row.label],['Attorney',row.attorney],['Due',date(row.deadline||row.matterDeadline)],['Practice area',row.practice],['State',row.state]];
    return node('dl',{className:'lc-properties'},pairs.filter(([,value])=>value).map(([label,value])=>node('div',{},[el('dt','',label),el('dd','',value)])));
  }
  async function select(row,{focus=true}={}){
    request?.abort();request=new AbortController();const signal=request.signal,version=++selectedVersion;
    const current=()=>valid()&&version===selectedVersion&&!signal.aborted&&pane?.isConnected;
    state.selected=row.key;updateSelection();pane?.remove();body.classList.add('has-selection');
    const compact=window.matchMedia('(max-width: 1100px)').matches;
    const close=compact?control('Back',()=>closePane(),'lc-back lc-link',{'aria-label':'Back to list'}):tool('Close details','close',()=>closePane());
    pane=node('section',{className:'lc-context','aria-label':'Record details','data-home-desktop-detail':''});
    const identity=row.contentTitle||row.title;
    const content=node('div',{className:'lc-context-content',tabindex:'0',role:'region','aria-label':identity},[node('h2',{text:identity,tabindex:'-1','data-home-detail-title':''})]);
    pane.append(node('header',{className:'lc-context-heading'},[el('span','',row.type==='event'?row.eventType:row.type==='submission'?'Submission':row.type==='matter'?'Matter':row.type==='invitation'?'Invitation':row.type==='recommendation'?'Listing':'Application'),close]),content);body.append(pane);
    if(focus){content.querySelector('h2').focus({preventScroll:true});requestAnimationFrame(keepSelectedRecordVisible);}
    if(row.type==='event'){
      content.append(el('p','lc-event-content',row.content),el('p','lc-meta',[row.actor,timestamp(row.eventAt)].filter(Boolean).join(' · ')));
      if(row.unread)void Promise.resolve(actions.markNotificationRead(row.notification)).then(confirmed=>{if(!valid()||!confirmed)return;row.unread=false;row.notification.isRead=true;row.notification.read=true;renderTabs();const item=[...list.querySelectorAll('[data-desktop-record]')].find(item=>item.dataset.desktopRecord===row.key);const label=item?.querySelector('.lc-unread');if(label)label.textContent='Read';});
      if(row.kind==='message' && row.href){window.location.hash=row.href;return;}
    }
    if(row.type==='invitation'||row.type==='application'){
      const source=actions.snapshot[row.type==='invitation'?'invites':'applications'];
      const record=values(source?.value).find(raw=>ownId(row.type==='invitation'?raw.caseId||raw._id||raw.id:raw._id||raw.id)===row.id);
      if(record){const embedded=actions.renderWorkContext({kind:row.type,record,snapshot:actions.snapshot,isValid:current});if(embedded)content.append(embedded);}
      else content.append(quiet('This record is no longer available.'));
      return;
    }
    content.append(properties(row));
    if(row.type==='recommendation') {if(row.description)content.append(el('p','lc-scope',row.description));if(row.href)content.append(link('Review listing and apply',row.href,'lc-primary'));return;}
    const matterId=row.caseId || row.id;
    if(row.type==='submission' || row.kind==='file') {
      const file=row.file || workspace.filesByMatter.get(matterId)?.find(file=>ownId(file)===row.fileId);
      if(!file){content.append(quiet('This file is no longer available or access has changed.'));if(row.href)content.append(link('Open referenced file',row.href,'lc-link'));return;}
      if(row.type==='submission' && row.category==='action')content.append(el('h3','','Revision request'),el('p','lc-scope',file.revisionNotes||'The attorney requested an updated file.'));
      content.append(el('h3','',file.originalName||file.filename||'File'),el('p','lc-meta',[file.mimeType,file.size?`${Math.ceil(file.size/1024)} KB`:'',file.version?`Version ${file.version}`:'',timestamp(file.uploadedAt||file.createdAt)].filter(Boolean).join(' · ')));
      if(['clean','not_required'].includes(file.securityStatus)){
        if(filePreviewable(file))content.append(node('a',{className:'lc-link',href:fileHref(matterId,ownId(file),{preview:true}),target:'_blank',rel:'noopener',text:'Open file preview'}));
        const download=control('Download file',async()=>{download.disabled=true;try{await actions.downloadFile(matterId,file,signal);}catch(error){if(current())content.append(el('p','lc-error',error.message||'The file could not be downloaded.'));}finally{if(current())download.disabled=false;}},'lc-primary');content.append(download);
      } else content.append(quiet(file.securityStatus==='blocked'?'This file is unavailable.':'File security verification is not complete.'));
      content.append(link(row.category==='action'?'Upload revision':'Open submission',`/matter/${encodeURIComponent(matterId)}?tab=files&fileId=${encodeURIComponent(ownId(file))}`,'lc-link'));return;
    }
    if(row.workspaceReady && (row.type==='matter'||row.kind==='scope')) {
      const loading=quiet('Loading authorized scope…');content.append(loading);
      try {
        const matter=await actions.loadMatter(matterId,signal);if(!current())return;loading.remove();
        if(!matter?.matterExperience?.sections?.some(section=>section.id==='work'||section.id==='files')){content.replaceChildren(quiet('Workspace access is no longer available.'));return;}
        content.append(el('h3','','Scope'),el('p','lc-scope',matter.details||matter.description||'No scope text is recorded.'));
        if(matter.tasks?.length) content.append(node('ul',{className:'lc-task-list'},matter.tasks.map(task=>el('li','',typeof task==='string'?task:task.title))));
        for(const revision of row.signals||[])content.append(node('section',{className:'lc-revision'},[el('h3','','Revision request'),el('p','lc-scope',revision.reason),link(`Open ${revision.contentTitle}`,revision.href,'lc-link')]));
        content.append(link(row.signals?.length?'Open files and revisions':'Open full workspace',row.signals?.[0]?.href || `/matter/${encodeURIComponent(matterId)}?tab=work`,'lc-primary'));
      }catch(error){if(!current())return;loading.textContent=[403,404].includes(Number(error.status))?'This matter is no longer available.':error.message||'The scope could not be loaded.';if(![401,403,404].includes(Number(error.status)))content.append(link('Open scope in workspace',`/matter/${encodeURIComponent(matterId)}?tab=work`,'lc-link'));}
    }else if(row.href)content.append(link(row.actionLabel||'Open full workspace',row.href,'lc-primary'));
  }
  input.addEventListener('input',()=>{if(!valid())return;state.search=input.value;renderList();});
  host.addEventListener('keydown',event=>{if(event.key==='Escape'&&state.selected&&!event.target.matches('input,textarea,select,[contenteditable=true]')){event.preventDefault();closePane();}});
  function sidebar(){
    document.querySelectorAll('[data-desktop-home-view]').forEach(a=>{
      const key=a.dataset.desktopHomeView;a.toggleAttribute('aria-current',false);if(key===view)a.setAttribute('aria-current','page');
      a.querySelector('[data-workspace-count]')?.remove();
      const count=key==='reviews'?workspace.counts.revisions:key==='work'?workspace.counts.invitations+workspace.counts.requests:0;
      if(count){const label=key==='reviews'?`${count} revision requests`:`${workspace.counts.invitations} invitations, ${workspace.counts.requests} application requests`;a.append(node('span',{className:'lc-sidebar-count','data-workspace-count':'',text:String(count),'aria-label':label,title:label}));}
    });
  }
  renderTabs();renderList();sidebar();list.scrollTop=state.listScroll||0;
  const selected=[...rows,...workspace.all,...workspace.events].find(row=>row.key===state.selected);
  if(selected)void select(selected,{focus:false});else if(!isWork)closePane(false);
}
