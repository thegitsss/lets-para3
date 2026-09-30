// Install before dashboard controls exist. Browser-wide activation can survive
// navigation, so only interaction with this document prevents a workspace switch.
(function () {
  let untouched = true;
  const events = ['pointerdown', 'keydown', 'input', 'change', 'submit'];
  const touched = () => { untouched = false; };
  const dispose = () => {
    for (const event of events) document.removeEventListener(event, touched, true);
    window.removeEventListener('pagehide', dispose);
  };
  for (const event of events) document.addEventListener(event, touched, { capture: true, once: true });
  window.addEventListener('pagehide', dispose, { once: true });
  window.lpcWorkspaceEntryGuard = Object.freeze({ isUntouched: () => untouched, dispose });
})();
