import { profileStates } from './profile-tour-markup.mjs';

export function createProfileTourSnippet() {
  const root = document.createElement('div');
  root.className = 'lpc-profile-snippet';
  root.innerHTML = '<div class="lpc-profile-snippet-stage v2-settings" aria-hidden="true" inert><div class="v2-settings-panel v2-profile-editor v2-profile-approved"><div class="v2-profile-editor-list v2-profile-approved-layout"><div class="v2-profile-group v2-profile-group--identity"></div></div></div><span class="lpc-profile-snippet-hint"></span></div><div class="lpc-profile-snippet-controls"><button type="button" data-pause aria-label="Pause profile demonstration">Pause</button><span data-caption aria-live="off">Your profile</span><button type="button" data-replay aria-label="Replay profile demonstration">Replay</button></div>';
  const stage = root.querySelector('.lpc-profile-snippet-stage');
  const slot = root.querySelector('.v2-profile-group');
  const caption = root.querySelector('[data-caption]');
  const pause = root.querySelector('[data-pause]');
  const replay = root.querySelector('[data-replay]');
  const hint = root.querySelector('.lpc-profile-snippet-hint');
  const motion = matchMedia('(prefers-reduced-motion: reduce)');
  const events = new AbortController();
  let elapsed = 0, previous = 0, frame = 0, state = '', paused = false, disposed = false;
  const animations = [];
  function paint() {
    const next = elapsed < 2600 ? 'before' : elapsed < 6400 ? 'editing' : 'saved';
    if (next !== state) {
      state = next;
      slot.innerHTML = profileStates[next === 'editing' ? 'editing' : 'before'];
      if (next === 'saved') slot.querySelector('[aria-label="Edit personal details yearsExperience"]').textContent = '13 years of experience';
      if (!motion.matches && next !== 'before') animations.push(slot.animate([{opacity:.45,transform:'translateY(3px)'},{opacity:1,transform:'translateY(0)'}],{duration:500,easing:'cubic-bezier(.2,.7,.3,1)'}));
    }
    const field = slot.querySelector('[aria-label="Edit personal details yearsExperience"], [data-profile-field="yearsExperience"]');
    if (state === 'editing') {
      const input = slot.querySelector('[data-profile-field="yearsExperience"]');
      input.value = elapsed < 3500 ? '12' : elapsed < 3950 ? '' : elapsed < 4300 ? '1' : '13';
    }
    caption.textContent = elapsed < 1600 ? 'Your profile' : elapsed < 3500 ? 'Select a detail to edit' : elapsed < 6400 ? 'Update your experience' : 'Changes save automatically';
    if (field && elapsed >= 1600 && elapsed < 6400 && !motion.matches) {
      const a = field.getBoundingClientRect(), b = stage.getBoundingClientRect();
      Object.assign(hint.style,{left:`${a.left-b.left-5}px`,top:`${a.top-b.top-4}px`,width:`${a.width+10}px`,height:`${a.height+8}px`,opacity:'1'});
    } else hint.style.opacity = '0';
    pause.textContent = paused ? 'Resume' : 'Pause';
    pause.setAttribute('aria-label',`${paused ? 'Resume' : 'Pause'} profile demonstration`);
    pause.hidden = elapsed >= 9600 || motion.matches;
    replay.hidden = motion.matches;
  }
  function tick(now) {
    if (disposed) return;
    if (!paused && !motion.matches && document.visibilityState !== 'hidden') elapsed = Math.min(9600, elapsed + (previous ? Math.min(now-previous,80) : 0));
    previous = now;
    paint();
    if (elapsed < 9600 && !motion.matches) frame = requestAnimationFrame(tick);
  }
  function start() {
    cancelAnimationFrame(frame); animations.splice(0).forEach(a=>a.cancel());
    elapsed = motion.matches ? 9600 : 0; previous = 0; paused = false; state = '';
    paint(); frame = requestAnimationFrame(tick);
  }
  pause.addEventListener('click',()=>{paused=!paused; animations.forEach(a=>paused?a.pause():a.play()); paint();},{signal:events.signal});
  replay.addEventListener('click',start,{signal:events.signal});
  motion.addEventListener('change',start,{signal:events.signal});
  root.__tourCleanup = () => { disposed=true; cancelAnimationFrame(frame); animations.forEach(a=>a.cancel()); events.abort(); };
  queueMicrotask(start);
  return root;
}
