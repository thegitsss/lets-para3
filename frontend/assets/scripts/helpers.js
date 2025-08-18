export function escapeHTML(s='') {
  return s.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
export const pillsFromCSV = (csv='') => csv.split(',').map(s=>s.trim()).filter(Boolean);
export const renderPills = (arr=[]) => arr.length ? arr.map(x=>`<span class="pill">${escapeHTML(x)}</span>`).join('') : '<span class="hint">None</span>';
