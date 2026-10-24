const el=id=>document.getElementById(id);
export function initSecondaryViews(){
  const posts=el('section-posts');
  const reports=document.createElement('details');reports.className='admin-detail-fold';reports.innerHTML='<summary>Reports & totals</summary>';
  posts.querySelector('header').after(reports);
  for(const node of [...posts.querySelectorAll(':scope>.grid-four,:scope>.grid-two')])reports.append(node);
  const knowledge=el('section-knowledge-studio');
  const select=document.createElement('select');select.id='adminKnowledgeView';select.setAttribute('aria-label','Knowledge view');
  select.innerHTML='<option value="knowledgeItemList">Approved answers</option><option value="knowledgeApprovalList">Awaiting review</option><option value="knowledgeSourceList">Sources</option>';
  knowledge.querySelector('header').after(select);
  const refresh=document.createElement('button');refresh.type='button';refresh.className='btn secondary';refresh.id='adminKnowledgeRefresh';refresh.textContent='Refresh';select.after(refresh);refresh.addEventListener('click',()=>window.loadKnowledgeStudio?.(true));
  const panels=['knowledgeItemList','knowledgeApprovalList','knowledgeSourceList'].map(id=>el(id).closest('.panel'));
  const detail=el('knowledgeDetailPanel').closest('.panel');
  const back=document.createElement('button');back.type='button';back.className='btn-link';back.textContent='← Back';detail.prepend(back);
  const show=()=>{panels.forEach(panel=>panel.hidden=!panel.contains(el(select.value)));detail.hidden=true;};
  select.addEventListener('change',show);back.addEventListener('click',show);
  for(const id of ['knowledgeItemList','knowledgeApprovalList']){
    const open=event=>{if(event.type==='keydown'&&!['Enter',' '].includes(event.key))return;if(!event.target.closest('[data-knowledge-item-id],[data-knowledge-approval-item-id]'))return;panels.forEach(panel=>panel.hidden=true);detail.hidden=false;back.focus({preventScroll:true});};
    el(id).addEventListener('click',open);el(id).addEventListener('keydown',open);
  }
  show();knowledge.classList.add('admin-knowledge-simple');
  const controls=el('auditSearch').closest('.pending-controls');
  const filters=document.createElement('details');filters.className='admin-detail-fold';filters.innerHTML='<summary>Filters & export</summary>';
  controls.after(filters);
  for(const node of [...controls.children])if(!['auditSearch','refreshAuditLogs'].includes(node.id))filters.append(node);
  const sync=()=>{
    for(const id of ['approvalItemDetail','engineeringDetail']){
      const node=el(id), panel=node?.closest('.panel');if(!panel)continue;
      const empty=node.querySelector(':scope>.ai-room-empty:only-child');
      panel.hidden=Boolean(empty && /^(Select |No .* (items|records))/i.test(empty.textContent.trim()));
    }
  };
  for(const id of ['approvalItemDetail','engineeringDetail'])if(el(id))new MutationObserver(sync).observe(el(id),{childList:true,subtree:true});
  sync();
  el('section-activity-logs').querySelector('header a[href="profile-settings.html#security"]')?.remove();
}
