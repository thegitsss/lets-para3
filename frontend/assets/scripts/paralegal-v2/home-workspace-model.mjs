// One presentation projection over the existing authorized Home sources.
import { adaptLegacyDestination } from './deep-links.mjs';
const id = value => String(value?._id || value?.id || value || '');
const time = value => value && Number.isFinite(Date.parse(value)) ? Date.parse(value) : 0;
const list = value => Array.isArray(value) ? value : value?.items || [];
const fileName = file => file.originalName || file.original || file.filename || 'Submission';
const stable = (a,b) => String(a.key || a.id).localeCompare(String(b.key || b.id));
export const WORK_TABS = Object.freeze([['work','Assigned'],['invitations','Invitations'],['applications','Applications'],['recommendations','Recommended']]);
export function compareWorkRecords(a,b) {
  // No invented priority or urgency scale. Optional numeric priorities must be
  // supplied by a documented source before they are projected here.
  return (a.deadline || '9999').localeCompare(b.deadline || '9999') || (b.eventAt || 0)-(a.eventAt || 0) || stable(a,b);
}
export function chooseWorkTab(workspace, explicit = '') {
  if (WORK_TABS.some(([key])=>key===explicit)) return explicit;
  if (workspace.tabs.work.length) return 'work';
  if (workspace.tabs.invitations.length) return 'invitations';
  if (workspace.tabs.applications.length) return 'applications';
  return 'recommendations';
}
export function buildHomeWorkspace(model) {
  const { sources } = model;
  const tabs = {work:[],invitations:[],applications:[],recommendations:[]};
  const reviews = {action:[],waiting:[],history:[]};
  const reviewSources = [];
  const matterById = new Map(model.activeWork.map(row=>[row.id,row]));
  const filesByMatter = new Map();
  for (const matter of model.activeWork.filter(row=>row.workspaceReady)) {
    const entry = sources.submissions?.value?.matters?.[matter.id];
    reviewSources.push({id:matter.id,state:entry?.state || sources.submissions?.state || 'loading'});
    if (entry?.state !== 'ready') continue;
    const files = Array.isArray(entry.value?.files) ? entry.value.files : [];
    filesByMatter.set(matter.id,files);
    for(const file of files) {
      if(file.uploadedByRole !== 'paralegal' || !id(file.id || file._id)) continue;
      const resolved = file.status === 'approved' || file.status === 'attorney_revision' && Boolean(file.revisionResolution);
      const responses = files.filter(f=>String(f.revisionOfFileId || '')===id(file) && f.revisionRequestAt && f.revisionRequestAt===file.revisionRequestedAt && !f.replacedAt);
      const awaitingResponseReview = responses.some(f=>f.status==='pending_review');
      const category = resolved ? 'history' : file.status === 'pending_review' ? 'waiting' : file.status === 'attorney_revision' && !awaitingResponseReview ? 'action' : '';
      if(!category || file.replacedAt) continue;
      const row = {...matter,id:id(file),caseId:matter.id,key:`submission:${matter.id}:${id(file)}`,type:'submission',file,unread:false,
        title:matter.title,contentTitle:fileName(file),label:category==='action'?'Revision requested':category==='waiting'?'Awaiting attorney':file.status==='approved'?'Approved':'Revision resolved',
        reason:category==='action'?file.revisionNotes || 'Updated file requested':category==='waiting'?'Submission awaiting attorney review':'Resolved submission',
        eventAt:time(category==='action'?file.revisionRequestedAt:category==='history'?file.approvedAt || file.revisionResolution?.approvedAt:file.uploadedAt || file.createdAt),
        href:`/matter/${encodeURIComponent(matter.id)}?tab=files&fileId=${encodeURIComponent(id(file))}`,category};
      reviews[category].push(row);
    }
  }
  // A rejected file read may remove its Matter from the visible work list.
  // Preserve the source outcome so that absence cannot become a verified zero.
  for (const [matterId,entry] of Object.entries(sources.submissions?.value?.matters || {})) {
    if (!reviewSources.some(source=>source.id===matterId)) reviewSources.push({id:matterId,state:entry.state});
  }
  for(const row of model.activeWork) {
    const revisions=reviews.action.filter(item=>item.caseId===row.id).sort(compareWorkRecords);
    const waiting=reviews.waiting.filter(item=>item.caseId===row.id);
    const overdue=row.overdue && (row.total === null || row.completed === null || row.completed < row.total);
    const group = revisions.length || overdue ? 'Needs your action' : waiting.length && row.total>0 && row.completed===row.total ? 'Waiting':'Active work';
    const reason=revisions[0]?.reason || (overdue?'Unresolved matter deadline is past due':group==='Waiting'?'Submitted work is awaiting attorney review':row.label);
    tabs.work.push({...row,key:`matter:${row.id}`,type:'matter',group,reason,signals:revisions,
      reference:'',eventAt:revisions[0]?.eventAt || row.eventAt});
  }
  for(const [name,type] of [['invitations','invitation'],['applications','application'],['recommendations','recommendation']]) {
    tabs[name]=model.opportunities[name].map(row=>({...row,key:`${type}:${row.id}`,type,reference:'',reason:row.detail || row.label})).sort(compareWorkRecords);
  }
  tabs.work.sort(compareWorkRecords);Object.values(reviews).forEach(rows=>rows.sort(compareWorkRecords));
  const all=[...Object.values(tabs).flat(),...Object.values(reviews).flat()];
  const events=list(sources.notifications?.value).map(item=>{
    const destination=adaptLegacyDestination(item.action?.href,{caseId:item.context?.caseId});
    const caseId=id(item.context?.caseId), matter=matterById.get(caseId);
    const type=String(item.type || 'update');
    const kind=item.context?.messageId || type==='message' ? 'message' : item.context?.fileId ? 'file' : /scope/.test(type)||destination?.href.includes('tab=work')?'scope':'event';
    return {id:id(item),key:`notification:${id(item)}`,type:'event',kind,caseId,
      title:matter?.title || item.message || 'Workspace update',reason:item.message || 'Recorded update',
      content:item.message || 'Recorded update',eventType:({case_work_updated:'Scope update',case_file_uploaded:'File shared',message:'Message'})[type] || type.replace(/_/g,' ').replace(/^case /,'Matter ').replace(/^./,letter=>letter.toUpperCase()),actor:item.actorFirstName || '',eventAt:time(item.createdAt),
      unread:item.isRead !== true && item.read !== true,available:item.available !== false,
      fileId:id(item.context?.fileId),messageId:id(item.context?.messageId),
      href:destination?.internal?destination.href.split('#')[1]: '',actionLabel:item.action?.label || 'Open update',
      workspaceReady:Boolean(matter?.workspaceReady), notification:item};
  }).filter(row=>row.id).sort((a,b)=>b.eventAt-a.eventAt || stable(a,b));
  return {tabs,reviews,reviewSources,filesByMatter,events,all,
    counts:{work:tabs.work.length,invitations:tabs.invitations.length,applications:tabs.applications.length,recommendations:tabs.recommendations.length,
      revisions:reviews.action.length,requests:tabs.applications.filter(row=>row.request).length},
    reviewsComplete:sources.dashboard.complete && sources.submissions?.complete && reviewSources.every(s=>s.state==='ready'),
    eventsComplete:sources.notifications?.complete === true};
}
