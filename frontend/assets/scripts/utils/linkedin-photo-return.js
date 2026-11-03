(() => {
  const ready = new URLSearchParams(location.search).get('status') === 'ready';
  document.getElementById('result-title').textContent = ready ? 'Photo ready' : 'Photo not imported';
  document.getElementById('result-copy').textContent = ready ? 'Return to LPC to edit your photo.' : 'Return to LPC to try again or upload a photo.';
  document.getElementById('close-window').addEventListener('click', () => window.close());
  history.replaceState(null, '', location.pathname);
  if (ready) window.close();
})();
