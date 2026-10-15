import { api, escapeHTML } from './shared.js';
import { confirmAction } from '../utils/dialogs.js';
export function initCorrespondenceSettings(parent) {
  const root=document.createElement('div');root.id='adminCorrespondenceSettings';
  root.innerHTML='<h3>Messages</h3><p>Automatic messages identify the LPC assistant. Your takeover stops new attempts; a message already underway may finish.</p><p data-correspondence-status role="status"></p><div data-correspondence-policies></div>';
  parent.append(root);let sequence=0,saving=false;
  const status=root.querySelector('[data-correspondence-status]'),list=root.querySelector('[data-correspondence-policies]');
  function render(data) {
    const openKinds=new Set([...list.querySelectorAll('details[open]')].map(detail=>detail.querySelector('form')?.dataset.correspondenceForm));
    const focused=root.contains(document.activeElement)?document.activeElement.id:'';
    const counts=data.counts||{},review=(counts.unknown||0)+(counts.failed||0),messages=[];
    if(review)messages.push(`${review} message ${review===1?'attempt needs':'attempts need'} delivery review. Check the mail provider before another reply.`);
    if(counts.pending)messages.push(`${counts.pending} automatic message ${counts.pending===1?'attempt is':'attempts are'} waiting for a worker check. Sending still depends on the current policy and account checks.`);
    if(counts.sending)messages.push(`${counts.sending} automatic message ${counts.sending===1?'attempt is':'attempts are'} underway. If confirmation is missing after 10 minutes, the next worker check moves the attempt to delivery review. Check the mail provider before another reply.`);
    if(counts.accepted)messages.push(`${counts.accepted} automatic message ${counts.accepted===1?'attempt was':'attempts were'} accepted by the mail provider. Inbox receipt is not confirmed here.`);
    if(counts.skipped)messages.push(`${counts.skipped} automatic message ${counts.skipped===1?'record is':'records are'} currently skipped. Check the message history for earlier attempts.`);
    status.textContent=messages.join(' ')||'No automatic message attempts recorded.';
    list.innerHTML=data.policies.map(row=>{
      const id=`correspondence-${row.kind}`,fields=[
        ['dailyAttemptLimit','Daily attempt limit',row.dailyAttemptLimit,1,25],
        ['startHour','Business hours start (0–23)',row.rules.startHour,0,23],
        ['endHour','Business hours end (1–24)',row.rules.endHour,1,24],
        ...(row.kind==='reminder'?[['reminderLimit','Maximum reminders',row.rules.reminderLimit,0,2],['reminderIntervalHours','Hours between reminders',row.rules.reminderIntervalHours,24,168]]:[]),
      ];
      return `<details class="admin-system-policy"><summary><span>${escapeHTML(row.label)}</span><span>${row.mode==='auto'?'Automatic messages':'Off'}</span></summary><p>${escapeHTML(row.description)}</p><form data-correspondence-form="${escapeHTML(row.kind)}" data-revision="${escapeHTML(row.revision)}"><label for="${escapeHTML(id)}-mode">Handling</label><select id="${escapeHTML(id)}-mode" name="mode"><option value="manual"${row.mode==='manual'?' selected':''}>Off — my review</option><option value="auto"${row.mode==='auto'?' selected':''}>Automatic messages</option></select>${fields.map(([name,label,value,min,max])=>`<label for="${escapeHTML(id)}-${name}">${escapeHTML(label)}</label><input id="${escapeHTML(id)}-${name}" name="${name}" type="number" min="${min}" max="${max}" step="1" value="${escapeHTML(value)}" required>`).join('')}<label for="${escapeHTML(id)}-zone">Time zone</label><input id="${escapeHTML(id)}-zone" name="timeZone" value="${escapeHTML(row.rules.timeZone)}" maxlength="80" required><p>Weekdays only. No automatic account or payment decisions.</p><button id="${escapeHTML(id)}-save" type="submit" class="btn secondary">Save message settings</button></form></details>`;
    }).join('');
    for(const row of data.policies){const form=list.querySelector(`[data-correspondence-form="${CSS.escape(row.kind)}"]`);form.policy=row;form.closest('details').open=openKinds.has(row.kind);}
    if(focused)document.getElementById(focused)?.focus({preventScroll:true});
  }
  async function refresh() {
    if(saving||root.contains(document.activeElement))return;
    const request=++sequence;status.textContent='Checking message settings…';
    try{const data=await api('/api/admin/workspace/correspondence/policies');if(request===sequence)render(data);}
    catch(error){if(request===sequence){list.replaceChildren();status.textContent=error.message||'Message settings are unavailable. Refresh to retry.';}}
  }
  root.addEventListener('submit',async event=>{
    const form=event.target.closest('[data-correspondence-form]');if(!form)return;event.preventDefault();if(saving)return;
    const data=new FormData(form),mode=data.get('mode'),previous=form.policy;
    if(mode==='auto'&&!await confirmAction(`Enable ${previous.label.toLowerCase()} during the saved business hours, with a daily limit of ${data.get('dailyAttemptLimit')} attempts?`,{title:'Enable automatic messages',confirmLabel:'Enable messages'}))return;
    const rules={...previous.rules,timeZone:String(data.get('timeZone')).trim()};
    for(const name of ['startHour','endHour','reminderLimit','reminderIntervalHours'])if(data.has(name))rules[name]=Number(data.get(name));
    saving=true;++sequence;const button=form.querySelector('button');button.disabled=true;status.textContent='Saving message settings…';
    try{const result=await api(`/api/admin/workspace/correspondence/policies/${form.dataset.correspondenceForm}`,{method:'PUT',body:{mode,rules,dailyAttemptLimit:Number(data.get('dailyAttemptLimit')),revision:form.dataset.revision,confirmed:mode==='auto'}});render(result);status.textContent=mode==='auto'?'Automatic message settings saved.':'Automatic messages are off for this policy.';}
    catch(error){if([401,403].includes(error.status))list.replaceChildren();status.textContent=error.message||'Settings could not be saved. Refresh to check the current policy.';}
    finally{saving=false;button.disabled=false;}
  });
  void refresh();return refresh;
}
