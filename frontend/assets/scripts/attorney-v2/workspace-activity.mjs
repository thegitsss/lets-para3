import { node, button, link, recoveryButton, setRecovery } from './dom.mjs';
import { matterLink, timeLabel, objectId } from './workspace-model.mjs';
export function createWorkspaceActivity(matter, {api,signal,ownerId,route}) {
  const root = node('section', {'aria-label':'Matter activity','data-workspace-activity':''});
  const feedback = node('p',{role:'status'}), list = node('ol',{className:'av2-matter-timeline'});
  const retry = recoveryButton('Retry activity',() => void load()), more = button('Show older activity',() => void load(true)); more.hidden = true;
  root.append(node('div',{className:'av2-section-heading'},[node('h2',{text:'Activity'}),retry]),node('p',{className:'av2-muted',text:'Recorded changes to this Matter. Private calendar activity is visible only to you.'}),feedback,list,more);
  let busy = false, rows = [], cursor = null;
  function render() {
    list.replaceChildren(...rows.map(item => {
      const query = new URLSearchParams(route.query), target = item.target;
      if (target) for (const key of ['fileId','messageId','taskId','eventId','applicantId']) if (objectId(target[key])) query.set(key,target[key]);
      if(target && Number.isSafeInteger(target.taskIndex) && target.taskIndex>=0 && target.taskIndex<10000)query.set('taskIndex',target.taskIndex);
      const href = target && matterLink(matter.id,target.tab,query);
      return node('li',{},[node('div',{},[href ? link(item.label,href,'av2-record-title') : node('strong',{text:item.label}),...(item.detail ? [node('p',{className:'av2-muted',text:item.detail})] : []),...(item.actorName ? [node('p',{className:'av2-muted',text:item.actorName})] : [])]),node('time',{datetime:item.at,text:timeLabel(item.at)})]);
    }));
    if (!rows.length) list.append(node('li',{text:'No activity is recorded.'}));
    more.hidden = !cursor;
  }
  async function load(append = false) {
    if (busy || signal.aborted || append && !cursor) return;
    busy = true; retry.disabled = true; more.disabled = true; root.dataset.state = 'loading'; feedback.textContent = append ? 'Loading older activity…' : 'Loading activity…';
    try {
      const history = await api.readWorkspaceHistory(matter.id,{signal,ownerId,...(append ? {cursor} : {})});
      if (signal.aborted) return;
      if (history.caseId !== matter.id || history.feedVersion && (history.feedVersion !== 1 || history.ownerId !== ownerId || typeof history.complete !== 'boolean') || !Array.isArray(history.items) || history.items.some(item => !item.label || !Number.isFinite(Date.parse(item.at))) || history.nextCursor !== undefined && history.nextCursor !== null && typeof history.nextCursor !== 'string') throw new Error('invalid_history');
      // Older status-only contracts carry a second projection. Normalize known
      // equivalent labels before merging so Posted does not appear twice.
      const canonical = label => label.toLowerCase().replace(/^(?:status:\s*|matter\s+)/,'').replace(/[^a-z0-9]/g,'');
      const combined = [...(append ? rows : []),...history.items,...(!append && !history.feedVersion ? matter.matterExperience.activity : [])];
      const seen = new Set(); rows = combined.filter(item => {
        if (!item.label || !Number.isFinite(Date.parse(item.at))) return false;
        const key = item.id || `${canonical(item.label)}|${new Date(item.at).toISOString()}`;
        if (seen.has(key)) return false; seen.add(key); return true;
      }).sort((a,b) => Date.parse(b.at)-Date.parse(a.at));
      cursor = history.nextCursor || null; render(); root.dataset.state = history.complete === false ? 'error' : 'ready';
      feedback.textContent = history.complete === false ? 'Some activity sources could not be checked. Retry activity to load their current records.' : history.feedVersion ? 'Times use your device’s time zone.' : 'Recorded status and available milestones. Times use your device’s time zone.';
    } catch { if (!signal.aborted) { if (!append) { rows = []; list.replaceChildren(); } cursor = null; more.hidden = true; root.dataset.state = 'error'; feedback.textContent = 'Activity couldn’t load. Retry activity to try again.'; } }
    finally { if (!signal.aborted) { busy = false; retry.disabled = false; more.disabled = false; setRecovery(retry,root); } }
  }
  root.readiness = load(); root.sync = () => root.dataset.state === 'error' || busy || root.contains(document.activeElement) || cursor || rows.length > 50 ? Promise.resolve() : load(); return root;
}
