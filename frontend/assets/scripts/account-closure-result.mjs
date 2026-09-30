import { createClosureApi } from './utils/account-closure-api.mjs';
import { readClosureProof, clearClosureProof } from './utils/account-closure-state.mjs';

const api = createClosureApi();
const root = document.querySelector('#main');
const title = document.querySelector('#closure-title');
const message = document.querySelector('#closure-message');
const actions = document.querySelector('#closure-actions');
let proof = readClosureProof(), loading = false, stopped = false, generation = 0;
function link(label, href, {leave = false} = {}) {
  const element = document.createElement('a');element.textContent = label;element.href = href;
  if (leave) element.addEventListener('click', () => {clearClosureProof();proof = null;});
  return element;
}
function checkButton() {
  const element = document.createElement('button');element.type = 'button';element.textContent = 'Check again';
  element.addEventListener('click', () => void check(true));return element;
}
function render(heading, text, controls, focus = false) {
  title.textContent = heading;message.textContent = text;actions.replaceChildren(...controls);
  root.setAttribute('aria-busy', 'false');if (focus) title.focus();
}
function settled() {clearClosureProof();proof = null;}
function checkingState() {
  title.textContent = 'Checking account status';message.textContent = 'Please keep this page open.';
  actions.replaceChildren();root.setAttribute('aria-busy', 'true');
}
async function check(focus = false) {
  if (loading || stopped) return;
  if (!proof) {
    render('Account check unavailable', 'Sign in to review your account, or contact LPC about a recent closure request.', [link('Sign in', '/login.html'),link('Contact LPC', '/contact.html')], focus);return;
  }
  loading = true;const ticket = ++generation;checkingState();
  try {
    const result = await api.readResult(proof);
    if (stopped || ticket !== generation) return;
    if (result.state === 'deactivated') {
      settled();render('Account deactivated', 'Past Matters and records of work, payments, disputes, and account activity are retained.', [link('Return home', '/'),link('Contact LPC', '/contact.html')], focus);
    } else if (result.state === 'active') {
      render('Your account is currently active', 'A recent closure request may still be processing. Leaving this check does not cancel that request.', [checkButton(),link('Leave check and sign in', '/login.html', {leave:true})], focus);
    } else {
      render('Account status unavailable', 'Keep this page open to check again, or contact LPC.', [checkButton(),link('Contact LPC', '/contact.html')], focus);
    }
  } catch (error) {
    if (stopped || ticket !== generation || error.name === 'AbortError') return;
    if (['expired', 'invalid_proof', 'authentication'].includes(error.kind)) {
      settled();
      const replaced = error.kind === 'authentication';
      render(replaced ? 'Session changed' : error.kind === 'expired' ? 'Account check expired' : 'Account check unavailable', replaced ? 'This check belongs to an earlier session. Sign in to continue with your current account.' : 'Sign in to review the current account, or contact LPC about a recent closure request.', [link('Sign in', '/login.html'),link('Contact LPC', '/contact.html')], focus);
    } else {
      render('Account status could not be checked', 'Keep this page open to check again. This will not send a new closure request.', [checkButton(),link('Contact LPC', '/contact.html')], focus);
    }
  } finally {if (ticket === generation) loading = false;}
}
window.addEventListener('pagehide', () => {stopped = true;generation++;loading = false;api.clear();checkingState();});
window.addEventListener('pageshow', event => {if (event.persisted) {stopped = false;proof = readClosureProof();void check();}});
void check();
