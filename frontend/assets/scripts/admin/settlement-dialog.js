import { replaceEventHandler } from '../utils/event-bindings.mjs';
import { escapeHTML as esc } from './shared.js';
import { icon } from './presentation.js';

// The preview comes from the existing server calculation. This dialog only
// presents it; the caller retains the original revision-checked settlement.
export function confirmAdminSettlement(preview) {
  return new Promise(resolve => {
    const previous = document.activeElement;
    const dialog = document.createElement('dialog');
    dialog.className = 'admin-settlement-dialog';
    dialog.setAttribute('aria-labelledby','adminSettlementTitle');
    dialog.setAttribute('aria-describedby','adminSettlementExplanation');
    const name = user => [user?.firstName,user?.lastName].filter(Boolean).join(' ') || user?.name || user?.email || 'Not recorded';
    const money = cents => new Intl.NumberFormat('en-US',{style:'currency',currency:preview.currency||'USD'}).format(Number(cents)/100);
    const rows = [['Paralegal receives',preview.payoutAmount],['Paralegal platform fee',preview.paralegalFee],['Attorney refund',preview.refundAmount],[preview.withdrawal?'Funds retained for the matter':'Attorney platform fee retained',preview.withdrawal?preview.remainingForMatter:preview.attorneyFee]];
    const action = preview.payoutAmount>0?'Release payout':preview.withdrawal?'Finalize zero payout':'Issue refund';
    dialog.innerHTML = `<p class="admin-eyebrow">REVIEW THE FINANCIAL OUTCOME</p><h2 id="adminSettlementTitle">${preview.withdrawal?'Finalize withdrawal dispute?':'Confirm financial settlement'}</h2><section class="admin-settlement-matter">${icon('matters')}<div><h3>${esc(preview.title)}</h3><p>Attorney: ${esc(name(preview.attorney))}<br>Paralegal: ${esc(name(preview.paralegal))}</p></div></section><dl class="admin-settlement-amounts">${rows.map(([title,value])=>`<div><dt>${esc(title)}:</dt><dd>${esc(money(value))}</dd></div>`).join('')}</dl><p id="adminSettlementExplanation">This closes the dispute. Payment-provider checks still apply when you submit.</p><div class="admin-settlement-actions"><button class="btn secondary" type="button" data-settlement-cancel autofocus>Cancel</button><button class="btn primary" type="button" data-settlement-confirm>${esc(action)} ${icon('arrow')}</button></div>`;
    let accepted = false;
    replaceEventHandler(dialog.querySelector('[data-settlement-cancel]'), 'click', ()=>dialog.close());
    replaceEventHandler(dialog.querySelector('[data-settlement-confirm]'), 'click', ()=>{accepted=true;dialog.close();});
    dialog.addEventListener('close',()=>{dialog.remove();if(previous?.isConnected)previous.focus();resolve(accepted);},{once:true});
    document.body.append(dialog);
    dialog.showModal();
    dialog.querySelector('[data-settlement-cancel]').focus();
  });
}
