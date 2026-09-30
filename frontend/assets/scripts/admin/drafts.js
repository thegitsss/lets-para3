import { replaceEventHandler } from '../utils/event-bindings.mjs';
import { api, escapeHTML as esc } from './shared.js';
import { getStoredSession } from '../auth.js';

export function createDraftStore(kind, { suppressToast = false } = {}) {
  const records = new Map();
  let generation = 0;
  function paint(d) {
    if(d.generation!==generation)return;
    document.querySelectorAll(`[data-draft-state="${kind}:${d.id}"]`).forEach(node=>{
      node.dataset.draftAttention = String(Boolean(d.error || d.saving || d.dirty));
      node.innerHTML = d.error ? `${esc(d.error)} ${d.conflict?'':'<button type="button" class="btn-link" data-retry-draft>Retry saving</button>'}` : d.saving ? 'Saving draft…' : d.dirty ? 'Draft has unsaved changes.' : d.revision ? 'Draft saved privately · expires after 30 days of inactivity.' : 'Drafts save privately as you type.';
      const retry=node.querySelector('[data-retry-draft]');
      if(retry)replaceEventHandler(retry, 'click', ()=>flush(d).catch(()=>paint(d)));
    });
  }
  async function load(id) {
    id=String(id);
    if(records.has(id))return records.get(id);
    const current=generation;
    const saved=await api(`/api/admin/workspace/drafts/${kind}/${id}`, { suppressToast });
    if(current!==generation)throw new Error('Your session changed. Reopen this record.');
    if(records.has(id))return records.get(id);
    const d={...saved,id,dirty:false,saving:null,timer:null,error:'',conflict:false,change:0,generation};
    records.set(id,d);return d;
  }
  function change(d) {
    d.dirty=true;d.change++;clearTimeout(d.timer);paint(d);
    if(!d.conflict)d.timer=setTimeout(()=>flush(d).catch(()=>paint(d)),500);
  }
  async function flush(d) {
    clearTimeout(d.timer);
    if(d.generation!==generation)throw new Error('Your session changed.');
    while(d.saving)await d.saving;
    if(d.conflict)throw new Error(d.error);
    if(!d.dirty)return;
    const snapshot={text:d.text,note:d.note,requestId:d.requestId,uncertain:d.uncertain,revision:d.revision};
    const changeAtStart=d.change;
    d.error='';
    d.saving=api(`/api/admin/workspace/drafts/${kind}/${d.id}`,{method:'PUT',body:snapshot,suppressToast});
    paint(d);
    try {
      const result=await d.saving;
      if(d.generation!==generation)return;
      d.revision=result.revision;d.dirty=d.change!==changeAtStart;
    } catch(error) {
      d.error=error.message;d.conflict=error.status===409;throw error;
    } finally {d.saving=null;paint(d);}
    if(d.dirty)await flush(d);
  }
  function clear() {generation++;for(const d of records.values())clearTimeout(d.timer);records.clear();}
  const initialUser=getStoredSession().user;
  let owner=String(initialUser?.id||initialUser?._id||'');
  addEventListener('lpc:user-updated',e=>{const next=String(e.detail?.id||e.detail?._id||'');if(owner&&owner!==next)clear();owner=next;});
  addEventListener('beforeunload',e=>{if([...records.values()].some(d=>d.dirty||d.saving)){e.preventDefault();e.returnValue='';}});
  return {load,change,flush,clear,paint,markup:d=>`<p class="small admin-draft-state" role="status" data-draft-state="${kind}:${esc(d.id)}"></p>`};
}
