(() => {
  // Keep the photograph and all SVG masks/filters unchanged. The mobile copy
  // supplies more pixels than the visible image needs without decoding 25 MP.
  const mobile = matchMedia('(max-width: 767px)');
  const sync = () => {
    const source = mobile.matches ? 'hero-mountain-mobile.jpg' : 'hero-mountain-restored.jpg';
    document.querySelectorAll('image[data-home-mountain]').forEach(image => {
      if (image.getAttribute('href') !== source) image.setAttribute('href', source);
    });
  };
  mobile.addEventListener('change', sync);
  sync();
})();
