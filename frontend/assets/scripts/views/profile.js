import { pillsFromCSV, renderPills, escapeHTML } from '../helpers.js';

async function uploadToBucket(supa, bucket, file, userId){
  const path = `${userId}/${Date.now()}-${file.name}`;
  const { data, error } = await supa.storage.from(bucket).upload(path, file, { upsert:true, contentType:file.type });
  if (error) return null;
  const { data: pub } = supa.storage.from(bucket).getPublicUrl(path);
  return pub?.publicUrl || null;
}

async function loadProfile({ USE_SUPABASE, supa, state }){
  if (USE_SUPABASE) {
    const { data } = await supa.from('profiles').select('*').eq('user_id', state.userRow.id).maybeSingle();
    return data || { user_id: state.userRow.id, headline:'', location:'', rate:null, availability:'Available', practice_areas:[], languages:[], bio:'', website:'', linkedin:'', avatar_url:'', resume_url:'' };
  }
  const key = `profile:${state.user.name}`;
  return JSON.parse(localStorage.getItem(key)||'null') || { headline:'', location:'', rate:'', availability:'Available', practice_areas:[], languages:[], bio:'', website:'', linkedin:'', avatar_url:'', resume_url:'' };
}
async function saveProfile({ USE_SUPABASE, supa, state }, profile){
  if (USE_SUPABASE) {
    await supa.from('profiles').upsert({ ...profile, user_id: state.userRow.id, updated_at: new Date().toISOString() });
  } else {
    localStorage.setItem(`profile:${state.user.name}`, JSON.stringify(profile));
  }
}

export async function render(el, ctx) {
  const { state, USE_SUPABASE, supa } = ctx;
  const prof = await loadProfile(ctx);
  const paCSV = (prof.practice_areas||[]).join(', ');
  const langCSV = (prof.languages||[]).join(', ');

  el.innerHTML = `
    <div class="section">
      <div class="section-title">My Profile</div>
      <div class="profile-wrap">
        <div class="profile-card">
          <img id="avatarPreview" class="avatar" alt="Profile photo" src="${escapeHTML(prof.avatar_url||'')}" onerror="this.src='https://placehold.co/400x400?text=Profile'"/>
          <div class="avatar-actions">
            <input type="file" id="avatarInput" accept="image/*" hidden/>
            <button class="btn" id="changePhoto">Change Photo</button>
          </div>
          <div style="margin-top:1rem;">
            <div><strong>${escapeHTML(state.user.name)}</strong></div>
            <div class="hint" style="text-transform:capitalize;">${escapeHTML(state.user.role)}</div>
          </div>
        </div>
        <div class="profile-card">
          <form id="profileForm" class="profile-grid">
            <div class="field"><label>Headline</label><input id="pfHeadline" value="${escapeHTML(prof.headline||'')}" placeholder="e.g., Senior Paralegal – Litigation"/></div>
            <div class="field"><label>Location</label><input id="pfLocation" value="${escapeHTML(prof.location||'')}" placeholder="City, State"/></div>
            <div class="field"><label>Hourly Rate ($/hr)</label><input id="pfRate" type="number" min="0" step="5" value="${prof.rate??''}"/></div>
            <div class="field"><label>Availability</label>
              <select id="pfAvail">
                ${['Available','Partial','Fully Booked'].map(v=>`<option ${prof.availability===v?'selected':''}>${v}</option>`).join('')}
              </select>
            </div>
            <div class="field col-span-2"><label>Practice Areas</label><input id="pfAreas" value="${escapeHTML(paCSV)}" placeholder="Civil Litigation, Family Law"/><div class="pill-row" id="areasPills">${renderPills(prof.practice_areas||[])}</div></div>
            <div class="field col-span-2"><label>Languages</label><input id="pfLangs" value="${escapeHTML(langCSV)}" placeholder="English, Spanish"/><div class="pill-row" id="langsPills">${renderPills(prof.languages||[])}</div></div>
            <div class="field col-span-2"><label>Bio</label><textarea id="pfBio" placeholder="Short professional bio">${escapeHTML(prof.bio||'')}</textarea></div>
            <div class="field"><label>Website</label><input id="pfWebsite" value="${escapeHTML(prof.website||'')}"/></div>
            <div class="field"><label>LinkedIn</label><input id="pfLinkedIn" value="${escapeHTML(prof.linkedin||'')}"/></div>
            <div class="field col-span-2">
              <label>Resume (PDF)</label>
              <div class="editable" style="margin:0;padding:0;gap:.5rem;">
                <input type="file" id="resumeInput" accept="application/pdf"/>
                <button type="button" class="btn secondary" id="uploadResume">Upload Resume</button>
                ${prof.resume_url?`<a id="resumeLink" href="${escapeHTML(prof.resume_url)}" target="_blank" class="hint">View current</a>`:'<span class="hint">No resume uploaded</span>'}
              </div>
            </div>
            <div class="profile-actions col-span-2">
              <span id="saveStatus" class="hint"></span>
              <button type="button" class="btn secondary" id="resetProfile">Reset</button>
              <button type="submit" class="btn" id="saveProfile">Save Profile</button>
            </div>
          </form>
        </div>
      </div>
    </div>
  `;

  const syncPills = () => {
    const a = pillsFromCSV(document.getElementById('pfAreas').value);
    const l = pillsFromCSV(document.getElementById('pfLangs').value);
    document.getElementById('areasPills').innerHTML = renderPills(a);
    document.getElementById('langsPills').innerHTML = renderPills(l);
  };
  document.getElementById('pfAreas').addEventListener('input', syncPills);
  document.getElementById('pfLangs').addEventListener('input', syncPills);

  document.getElementById('changePhoto').onclick = () => document.getElementById('avatarInput').click();
  document.getElementById('avatarInput').onchange = async (e) => {
    const file = e.target.files?.[0]; if (!file) return;
    const preview = document.getElementById('avatarPreview');
    preview.src = URL.createObjectURL(file);
    if (ctx.USE_SUPABASE) {
      const url = await uploadToBucket(ctx.supa, 'avatars', file, ctx.state.userRow.id);
      if (url) { prof.avatar_url = url; await saveProfile(ctx, prof); }
    } else {
      const reader = new FileReader(); reader.onload = async () => { prof.avatar_url = reader.result; await saveProfile(ctx, prof); }; reader.readAsDataURL(file);
    }
  };

  document.getElementById('uploadResume').onclick = async () => {
    const f = document.getElementById('resumeInput').files?.[0]; if (!f) { alert('Select a PDF first'); return; }
    if (ctx.USE_SUPABASE) {
      const url = await uploadToBucket(ctx.supa, 'resumes', f, ctx.state.userRow.id);
      if (url) { prof.resume_url = url; await saveProfile(ctx, prof); await render(el, ctx); }
    } else {
      const reader = new FileReader(); reader.onload = async () => { prof.resume_url = reader.result; await saveProfile(ctx, prof); await render(el, ctx); }; reader.readAsDataURL(f);
    }
  };

  document.getElementById('resetProfile').onclick = async () => { await render(el, ctx); };

  document.getElementById('profileForm').addEventListener('submit', async (ev)=>{
    ev.preventDefault();
    prof.headline     = document.getElementById('pfHeadline').value.trim();
    prof.location     = document.getElementById('pfLocation').value.trim();
    const rateVal     = document.getElementById('pfRate').value.trim();
    prof.rate         = rateVal ? Number(rateVal) : null;
    prof.availability = document.getElementById('pfAvail').value;
    prof.practice_areas = pillsFromCSV(document.getElementById('pfAreas').value);
    prof.languages      = pillsFromCSV(document.getElementById('pfLangs').value);
    prof.bio         = document.getElementById('pfBio').value.trim();
    prof.website     = document.getElementById('pfWebsite').value.trim();
    prof.linkedin    = document.getElementById('pfLinkedIn').value.trim();

    const status = document.getElementById('saveStatus');
    status.textContent = 'Saving...';
    await saveProfile(ctx, prof);
    status.textContent = 'Saved';
    status.className = 'success';
    setTimeout(()=>{ status.textContent=''; status.className='hint'; }, 1500);
  });
}
