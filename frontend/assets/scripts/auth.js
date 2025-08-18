window.addEventListener('DOMContentLoaded', () => {
  document.body.classList.add('loaded');
});

// Helper to show messages
export function showMsg(el, txt) {
  el.textContent = txt;
}

// Show/hide recaptcha error
export function isRecaptchaValid(siteKey, el) {
  const token = grecaptcha.getResponse();
  if (!token) {
    showMsg(el, 'Please verify you are not a robot.');
    return false;
  }
  return true;
}
