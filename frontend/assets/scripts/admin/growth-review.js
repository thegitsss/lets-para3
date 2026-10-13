import { readDirectorOversight } from './financial-read.js';
import { api, escapeHTML as esc } from './shared.js';
export function initGrowthReview(section) {
  if(!section)return async()=>{};
  const root=document.createElement('section');root.className='panel workspace-panel';root.id='adminGrowthReview';
  root.innerHTML='<div class="panel-header"><div><h2>Weekly review</h2><p class="small">One list of current LinkedIn decisions, including unfinished earlier drafts. Approval and publication are separate.</p></div><button class="btn secondary" type="button" id="adminWeeklyReviewRefresh" data-growth-refresh>Refresh review</button></div><div data-growth-marketing role="status"></div><details class="admin-detail-fold"><summary>Director oversight</summary><div data-growth-directors role="status"></div><p><a class="btn-link" href="admin-directors.html">Open director records and payment history</a></p></details>';
  section.querySelector('header').after(root);let sequence=0;
  const marketing=root.querySelector('[data-growth-marketing]'),directors=root.querySelector('[data-growth-directors]');
  const link=row=>row.reviewAvailable===true?`<button class="btn secondary" type="button" data-growth-packet="${esc(row.id)}">Review draft</button>`:'<p class="admin-row-meta" role="status">Approval record unavailable. This draft cannot be reviewed yet.</p>';
  async function refresh(){
    const request=++sequence;marketing.textContent='Checking weekly drafts…';directors.textContent='Checking director records…';
    const results=await Promise.allSettled([api('/api/admin/marketing/weekly-review'),readDirectorOversight('/api/admin/directors/overview?limit=50')]);
    if(request!==sequence)return;
    const [weekly,oversight]=results;
    // A revoked session clears both sections, even if an earlier response succeeded.
    if(results.some(row=>row.status==='rejected'&&[401,403].includes(row.reason.status))){marketing.textContent='Verify your administrator session.';directors.replaceChildren();return;}
    if(weekly.status==='fulfilled'){
      const data=weekly.value;
      marketing.innerHTML=`<p class="small">Week of ${esc(data.weekStart.slice(0,10))} · UTC${data.limited?' · Showing the first '+data.items.length+' of '+data.total+' drafts':''}</p>`+(data.items.length?data.items.map(row=>`<article class="admin-review-card"><h3>${esc(row.title)}</h3><p class="admin-row-meta">${esc(row.approvalState.replaceAll('_',' '))}${row.olderPending?' · Earlier unfinished review':''}</p>${link(row)}</article>`).join(''):'<p>No drafts need this week’s review.</p>');
    }else marketing.textContent='Weekly drafts are unavailable. Refresh to retry.';
    if(oversight.status==='fulfilled'){
      const data=oversight.value,attention=data.records.filter(row=>['founder_attention','follow_up_failed'].includes(row.stage));
      directors.innerHTML=`<p>${esc(data.directors.length)} directors · ${esc(data.totalRecords)} referral records</p>`+(attention.length?attention.map(row=>`<article class="admin-review-card"><h3>${esc(row.attorneyName||'Referral')}</h3><p class="admin-row-meta">${esc(row.stageLabel||row.stage)} · ${esc(row.directorEmail)}</p></article>`).join(''):'<p>No reply or follow-up exception appears in the displayed records.</p>')+(data.totalRecords>data.records.length?'<p>The overview shows 50 recent records. Open director records for the complete history.</p>':'');
    }else directors.textContent='Director records are unavailable. Other Growth work remains accessible.';
  }
  root.addEventListener('click',event=>{if(event.target.closest('[data-growth-refresh]'))void refresh();const button=event.target.closest('[data-growth-packet]');if(button)window.openApprovalWorkspaceItem?.(`marketing_draft_packet:${button.dataset.growthPacket}`);});
  window.addEventListener('admin:financial-account-changed',()=>{++sequence;marketing.textContent='Verify your administrator session.';directors.replaceChildren();});
  window.addEventListener('storage',event=>{if(event.key==='lpc_user'){++sequence;marketing.textContent='Check your account before reviewing drafts.';directors.replaceChildren();}});
  return refresh;
}
