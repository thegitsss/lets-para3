import { node, action } from './shared.mjs';
import { candidateHref, profilePhoto } from '../attorney-v2/candidate-model.mjs';
export function createNativeMatching({ api, signal, context = new URLSearchParams(), returnHref = '#/paralegals?match=work', state = {} }) {
  const root = node('section', { className: 'lpc-connected-matching', 'data-native-matching': '', 'aria-label': 'Find paralegals by work' });
  const form = node('form', { className: 'lpc-connected-match-form' });
  const queryId = 'lpc-match-' + crypto.randomUUID();
  const query = node('textarea', { id: queryId, rows: '4', maxlength: '1500', required: '', minlength: '3', placeholder: 'For example: organize discovery responses and build a medical-record chronology for an attorney-led matter.' }); query.value = state.query || '';
  const years = node('input', { type: 'number', min: '0', max: '80', step: '1', value: state.minimumYears || '', inputmode: 'numeric' });
  const skills = node('input', { type: 'text', maxlength: '900', placeholder: 'e.g. discovery, legal research', value: state.skills || '' });
  const available = node('input', { type: 'checkbox', ...(state.availableOnly ? { checked: '' } : {}) });
  const find = node('button', { type: 'submit', className: 'lpc-connected-button', text: 'Find relevant experience' });
  const filters = node('details', { className: 'lpc-connected-match-filters' }, [node('summary', { text: 'Refine requirements' }), node('div', { className: 'lpc-connected-filter-grid' }, [node('label', {}, [node('span', { text: 'Minimum years of experience' }), years]), node('label', {}, [node('span', { text: 'Required skills' }), skills]), node('label', { className: 'lpc-connected-check' }, [available, node('span', { text: 'Available paralegals only' })])]), node('p', { className: 'lpc-connected-meta', text: 'Required skills must be listed on the profile. Separate skills with commas.' })]);
  form.append(node('span', { className: 'lpc-connected-eyebrow', text: 'Start with the work' }), node('h2', { text: 'Describe what you need done.' }), node('p', { className: 'lpc-connected-note', text: 'Find experience that fits the work, even when a profile uses different words.' }), node('label', { for: queryId, className: 'lpc-connected-field-label', text: 'Work description' }), query, filters, node('div', { className: 'lpc-connected-actions' }, [find, node('span', { className: 'lpc-connected-meta', text: 'Searches approved public profiles.' })]));
  const feedback = node('p', { role: 'status', className: 'lpc-connected-feedback', 'aria-live': 'polite' });
  const results = node('div', { className: 'lpc-connected-match-results' });
  root.append(form, feedback, results);
  let busy = false;
  const alive = () => !signal?.aborted;
  function remember() { Object.assign(state, { query: query.value, minimumYears: years.value, skills: skills.value, availableOnly: available.checked }); }
  for (const control of [query, years, skills, available]) control.addEventListener('input', remember);
  function show(result) {
    results.replaceChildren();
    if (!Array.isArray(result.items)) throw new Error('Search results could not be read. Please try again.');
    results.append(node('div', { className: 'lpc-connected-result-heading' }, [node('h2', { text: result.items.length ? 'Experience to consider' : 'No profiles match these requirements' }), node('span', { className: 'lpc-connected-meta', text: result.items.length ? result.items.length + ' profile' + (result.items.length === 1 ? '' : 's') : '' })]));
    if (!result.items.length) results.append(node('p', { className: 'lpc-connected-note', text: 'Try a broader description or adjust the required skills and availability filter.' }));
    for (const profile of result.items) {
      const params = new URLSearchParams(context); params.set('returnTo', returnHref);
      const href = candidateHref(profile.id, params);
      const img = node('img', { src: profilePhoto('', profile.id, location.origin), alt: '', width: '48', height: '48', loading: 'lazy' }); img.addEventListener('error', () => { img.src = '/assets/avatar-placeholder.svg'; }, { once: true });
      const card = node('article', { className: 'lpc-connected-match-card' });
      const title = node('div', { className: 'lpc-connected-profile-heading' }, [img, node('div', {}, [node('h3', {}, [node('a', { href, text: profile.name })]), node('p', { className: 'lpc-connected-meta', text: [profile.location, Number.isFinite(profile.yearsExperience) ? profile.yearsExperience + ' years of experience' : ''].filter(Boolean).join(' · ') })]), node('span', { className: 'lpc-connected-availability', text: profile.availability === 'available' ? 'Available' : profile.availability === 'unavailable' ? 'Unavailable' : 'Confirm availability' })]);
      const evidence = node('details', { className: 'lpc-connected-match-evidence' }, [node('summary', { text: 'Why this profile appeared' })]);
      for (const item of profile.evidence || []) evidence.append(node('div', {}, [node('span', { className: 'lpc-connected-meta', text: ({ skills: 'Listed skills', practices: 'Practice areas', bio: 'Profile', bestFor: 'Work interests', experience: 'Experience' })[item.field] || 'Profile information' }), node('p', { text: item.text })]));
      if (!profile.evidence?.length) evidence.append(node('p', { text: 'Review the full profile to assess the fit.' }));
      evidence.append(node('p', { className: 'lpc-connected-meta', text: 'Experience is self-reported. Confirm relevant details with the paralegal.' }));
      const requirements = (profile.requirements || []).filter(item => item.state === 'confirmation_required');
      card.append(title, evidence);
      if (requirements.length) card.append(node('p', { className: 'lpc-connected-meta', text: 'Confirm directly: ' + requirements.map(item => item.text).join(' · ') }));
      card.append(node('a', { href, className: 'lpc-connected-profile-link', text: 'View profile →' })); results.append(card);
    }
    if (result.note) results.append(node('p', { className: 'lpc-connected-meta', text: result.note }));
  }
  async function search(event) {
    event?.preventDefault(); if (busy || !alive()) return;
    if (!form.reportValidity()) return;
    const requiredSkills = skills.value.split(',').map(value => value.trim()).filter(Boolean);
    if (requiredSkills.length > 12 || requiredSkills.some(value => value.length > 70)) { feedback.textContent = 'Use up to 12 required skills, each under 70 characters.'; feedback.setAttribute('role', 'alert'); return; }
    remember(); state.hasSearched = true;
    const body = { query: query.value.trim(), minimumYears: Number(years.value || 0), availableOnly: available.checked, requiredSkills };
    if (/^[a-f0-9]{24}$/i.test(context.get('caseId') || '')) body.caseId = context.get('caseId');
    busy = true; find.disabled = true; find.textContent = 'Finding relevant experience…'; results.replaceChildren(); feedback.textContent = 'Comparing the work with profile experience…'; feedback.setAttribute('role', 'status');
    try { const result = await api.write('/api/paralegal-matching/search', body); if (!alive()) return; show(result); feedback.textContent = result.items.length + ' relevant profile' + (result.items.length === 1 ? '' : 's') + ' found.'; }
    catch (error) { if (alive()) { feedback.textContent = error.message; feedback.setAttribute('role', 'alert'); results.replaceChildren(action('Try this search again', () => void search(), 'lpc-connected-button is-secondary')); } }
    finally { busy = false; if (alive()) { find.disabled = false; find.textContent = 'Find relevant experience'; } }
  }
  form.addEventListener('submit', event => void search(event));
  root.readiness = state.hasSearched && query.value.trim().length >= 3 ? search() : Promise.resolve();
  return root;
}
