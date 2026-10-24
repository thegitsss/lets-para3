import { node, link, recoveryButton, setRecovery } from './dom.mjs';
import { matterLink } from './workspace-model.mjs';
import { readCompletion, blockerText } from './completion-model.mjs';
import { readWithdrawal } from './withdrawal-model.mjs';
import { readFinancialHistory, financialMoney } from './financial-history-model.mjs';

const metric = () => node('a', {className:'av2-matter-metric','data-av2-route':''});
function fillMetric(target, label, value, detail = '') {
  target.replaceChildren(node('span', {text:label}), node('strong', {text:value}), ...(detail ? [node('span', {className:'av2-muted',text:detail})] : []));
}
export function createMatterReviewSummary(matter, context, {financial = false, work = false} = {}) {
  const {api, signal, ownerId, route} = context, caseId = matter.id;
  const root = node('section', {className:'av2-matter-review-summary', 'aria-label':financial ? 'Matter funds summary' : 'Matter review summary'});
  const heading = node('h2', {text:financial ? 'Matter funds' : work ? 'Review progress' : 'At a glance'});
  const metrics = node('div', {className:'av2-matter-metrics'}), attention = node('section', {className:'av2-matter-attention', 'aria-label':'Needs your attention'});
  const feedback = node('p', {role:'status'}), retry = recoveryButton('Retry Matter summary', () => void load());
  const workMetric = metric(), documentsMetric = metric(), applicationsMetric = metric(), fundsMetric = metric();
  workMetric.href = matterLink(caseId,'work',route.query); documentsMetric.href = matterLink(caseId,'files',route.query);
  applicationsMetric.href = matterLink(caseId,'applications',route.query); fundsMetric.href = matterLink(caseId,'financials',route.query);
  const progress = matter.matterExperience.overview.taskProgress;
  fillMetric(workMetric,'Agreed work',progress ? `${progress.completed} of ${progress.total} complete` : 'Unavailable');
  const pending = matter.matterExperience.applications?.pendingCount;
  const retainedApplications=Boolean(matter.matterExperience.overview.paralegalId || matter.archived || matter.readOnly || ['completed','closed','cancelled','canceled','expired'].includes(matter.status));
  fillMetric(applicationsMetric,retainedApplications ? 'Applications' : 'Applications to review',retainedApplications ? 'View history' : Number.isSafeInteger(pending) ? String(pending) : 'Unavailable');
  fillMetric(documentsMetric,'Documents to review','Checking…'); fillMetric(fundsMetric,'Remaining Matter funds','Checking…');
  metrics.append(...(financial ? [fundsMetric,workMetric,documentsMetric] : work ? [workMetric,documentsMetric] : [workMetric,documentsMetric,applicationsMetric,fundsMetric]));
  root.append(node('div',{className:'av2-section-heading'},[heading,retry]), metrics,feedback,attention);
  let busy = false, completion = null, balance = null, history = null;
  const options = {ownerId, signal};
  function row(reason, label, tab, detail = '') {
    return node('li', {}, [node('div',{},[node('strong',{text:reason}), ...(detail ? [node('p',{className:'av2-muted',text:detail})] : [])]), link(label,matterLink(caseId,tab,route.query))]);
  }
  function renderAttention() {
    const rows = [], header = matter.matterExperience.header;
    if (completion?.documents.awaitingReview) rows.push(row(`${completion.documents.awaitingReview} document${completion.documents.awaitingReview === 1 ? '' : 's'} awaiting review`,'Review documents','files'));
    if (completion?.documents.revisions) rows.push(row('Document revisions requested','View revisions','files',`${completion.documents.revisions} document${completion.documents.revisions === 1 ? '' : 's'} awaiting changes`));
    if (completion?.canComplete) rows.push(row('Ready for completion review','Review completion','financials','Review the agreed work, documents and payment before closing this Matter.'));
    else if (financial && completion && !completion.closed && !completion.completedAt) {
      for (const key of completion.blockers.filter(key => !['active_matter_required','assigned_paralegal_required'].includes(key))) {
        const tab = /task|scope/.test(key) ? 'work' : /document|security/.test(key) ? 'files' : 'financials';
        rows.push(row(blockerText(key), tab === 'work' ? 'Review agreed work' : tab === 'files' ? 'Review documents' : 'Review payment','' + tab));
      }
    }
    if (header.attention && header.primaryAction && !rows.some(item => item.textContent.includes(header.primaryAction.label))) rows.push(row(header.attention,header.primaryAction.label,header.primaryAction.tab,header.primaryAction.detail));
    attention.replaceChildren(...(rows.length ? [node('h3',{text:'Needs your attention'}),node('ul',{className:'av2-matter-attention-list'},rows)] : []));
    attention.hidden = !rows.length;
  }
  async function load({ quiet = false } = {}) {
    if (busy || signal.aborted) return;
    const passive = quiet && root.dataset.state === 'ready';
    busy = true; retry.disabled = true; root.dataset.state = 'loading'; if (!passive) feedback.textContent = 'Checking review and funding records…';
    const reads = [api.readCompletion(caseId,options), ...(work ? [] : [api.readWithdrawal(caseId,options)]), ...(financial ? [api.readFinancialHistory({...options,caseId,view:'all',q:''})] : [])];
    const results = await Promise.allSettled(reads);
    if (signal.aborted) return;
    const failures = [];
    try { if (results[0].status !== 'fulfilled') throw results[0].reason; completion = readCompletion(results[0].value,caseId,ownerId); fillMetric(workMetric,'Agreed work',`${completion.work.complete} of ${completion.work.total} complete`); fillMetric(documentsMetric,'Documents to review',String(completion.documents.awaitingReview),`${completion.documents.approved} approved${completion.documents.revisions ? ` · ${completion.documents.revisions} need revisions` : ''}`); }
    catch { completion = null; fillMetric(documentsMetric,'Documents to review','Unavailable'); failures.push('document review'); }
    if (!work) {
      try { if (results[1].status !== 'fulfilled') throw results[1].reason; balance = readWithdrawal(results[1].value,caseId,ownerId); fillMetric(fundsMetric,'Remaining Matter funds',balance.balanceVerified && balance.fundingReady ? financialMoney(balance.remainingCents,balance.currency) : 'Not verified',balance.fundingReady ? 'Before a new release decision' : 'Funding needs review'); }
      catch { balance = null; fillMetric(fundsMetric,'Remaining Matter funds','Unavailable'); failures.push('Matter funds'); }
    }
    let historyMetrics = metrics.querySelector('[data-financial-summary]'); historyMetrics?.remove();
    if (financial) {
      try {
        if (results[2].status !== 'fulfilled') throw results[2].reason;
        history = readFinancialHistory(results[2].value,ownerId,{view:'all',q:'',caseId});
        const totals = node('dl',{className:'av2-matter-facts av2-funds-recorded','data-financial-summary':''});
        for (const group of history.summary.currencies) for (const [label,key,count] of [['Original card payment','originalFunding','fundingRecords'],['Recorded net payouts','paralegalPayouts','payoutRecords'],['Processed refunds','refunds','refundRecords']]) if (group[count]) totals.append(node('div',{},[node('dt',{text:label}),node('dd',{text:financialMoney(group[key],group.currency)})]));
        if (history.summary.pending || history.summary.requiresReview) totals.append(node('div',{},[
          node('dt',{text:'Records needing attention'}),
          node('dd',{text:`${history.summary.pending} pending · ${history.summary.requiresReview} need review`}),
        ]));
        if (totals.children.length) metrics.append(totals);
      } catch { history = null; failures.push('transaction totals'); }
    }
    busy = false; retry.disabled = false; root.dataset.state = failures.length ? 'error' : 'ready';
    feedback.textContent = failures.length ? `Some summary information is unavailable: ${failures.join(', ')}. Retry to check its current records.` : '';
    renderAttention(); setRecovery(retry,root);
  }
  renderAttention(); root.sync = () => root.contains(document.activeElement) ? Promise.resolve() : load({quiet:true}); root.readiness = load(); return root;
}
