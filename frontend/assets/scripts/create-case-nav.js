(function () {
  function handleNavClick(event) {
    event.preventDefault();
    const target = this.getAttribute('data-target');
    if (target) {
      window.location.href = target;
    }
  }

  function initNavButtons() {
    document.querySelectorAll('[data-nav][data-target]').forEach((btn) => {
      btn.removeEventListener('click', handleNavClick);
      btn.addEventListener('click', handleNavClick);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initNavButtons);
  } else {
    initNavButtons();
  }
})();
