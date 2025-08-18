export async function render(el, { state, USE_SUPABASE, supa, escapeHTML }) {
  let paralegalsHTML = '';
  if (USE_SUPABASE) {
    const { data: parts } = await supa
      .from('job_participants')
      .select('users!inner(name,role)')
      .eq('job_id', state.job.id);
    const ps = (parts||[]).filter(p=>p.users?.role==='paralegal').map(p=>`<li>${escapeHTML(p.users.name)}</li>`);
    paralegalsHTML = ps.length ? ps.join('') : '<li>No active paralegals</li>';
  } else {
    const parts = state.job.participants || [];
    const ps = parts.filter(p=>p.role==='paralegal').map(p=>`<li>${escapeHTML(p.name)}</li>`);
    paralegalsHTML = ps.length ? ps.join('') : '<li>No active paralegals</li>';
  }

  el.innerHTML = `
    <div class="overview-grid">
      <div class="overview-bubble">
        <div class="section-title">Open Jobs</div>
        <ul><li>${escapeHTML(state.job.name)} <span class="status-badge">${escapeHTML(state.job.status)}</span></li></ul>
      </div>
      <div class="overview-bubble">
        <div class="section-title">Active Paralegal(s)</div>
        <ul>${paralegalsHTML}</ul>
      </div>
      <div class="overview-bubble">
        <div class="section-title">Notifications</div>
        <ul><li>No notifications</li></ul>
      </div>
      <div class="overview-bubble">
        <div class="section-title">Quick Links</div>
        <button onclick="location.hash='calendar'">View Calendar</button>
        <button onclick="location.hash='checklist'">Open Checklist</button>
      </div>
    </div>
  `;
}
