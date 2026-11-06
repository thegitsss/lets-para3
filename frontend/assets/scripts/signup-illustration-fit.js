(() => {
  const figures = [...document.querySelectorAll('.lpc-entry-preview')];
  const canvasSize = 560;
  const maximumScale = (550 - 16) / canvasSize;
  const rounded = value => Math.round(value * 1000000) / 1000000;

  function fit(figure) {
    const panel = figure.closest('.signup-aside-copy, .login-aside-copy');
    const story = panel?.querySelector('.auth-story');
    const canvas = figure.querySelector('.lpc-entry-preview__canvas');
    if (!panel?.clientHeight || !figure.clientWidth || !story || !canvas) return;

    const canvasRect = canvas.getBoundingClientRect();
    const currentScale = canvasRect.width / canvasSize || 1;
    const cards = [...canvas.children].filter(card => card.classList.contains('lpc-closeup'));
    if (!cards.length) return;
    const bounds = cards.map(card => card.getBoundingClientRect());
    const left = (Math.min(...bounds.map(r => r.left)) - canvasRect.left) / currentScale;
    const right = (Math.max(...bounds.map(r => r.right)) - canvasRect.left) / currentScale;
    const top = (Math.min(...bounds.map(r => r.top)) - canvasRect.top) / currentScale;
    const bottom = (Math.max(...bounds.map(r => r.bottom)) - canvasRect.top) / currentScale;
    const width = right - left;
    const height = bottom - top;
    const style = getComputedStyle(panel);
    const availableHeight = panel.clientHeight - parseFloat(style.paddingTop)
      - parseFloat(style.paddingBottom) - story.getBoundingClientRect().height
      - (parseFloat(style.rowGap) || 0);
    const scale = rounded(Math.max(0, Math.min(maximumScale,
      (figure.clientWidth - 16) / width, availableHeight / height)));

    // Center the visible cards, including rotations, rather than the unused canvas.
    figure.style.height = `${rounded(height * scale)}px`;
    figure.style.setProperty('--auth-preview-scale', String(scale));
    canvas.style.left = `calc(50% + ${rounded((canvasSize / 2 - (left + right) / 2) * scale)}px)`;
    canvas.style.top = `${rounded(-top * scale)}px`;
  }

  let frame;
  const schedule = () => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => figures.forEach(fit));
  };
  figures.forEach(fit);
  document.fonts.ready.then(schedule);
  if (typeof ResizeObserver === 'function') {
    const observer = new ResizeObserver(schedule);
    for (const figure of figures) {
      observer.observe(figure);
      const panel = figure.closest('.signup-aside-copy, .login-aside-copy');
      if (panel) observer.observe(panel);
      const story = panel?.querySelector('.auth-story');
      if (story) observer.observe(story);
    }
  } else {
    window.addEventListener('resize', schedule);
  }
})();
