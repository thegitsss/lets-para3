(() => {
  const canvas = document.querySelector('[data-paralegal-map]');
  if (!canvas) return;
  const summaryElement = document.querySelector('[data-map-summary]');
  const growthElement = document.querySelector('[data-map-growth]');
  const totalElement = document.querySelector('[data-map-total]');
  const statusElement = document.querySelector('[data-map-status]');
  const setStatus = (total, summary) => {
    totalElement.textContent = total;
    summaryElement.textContent = summary;
  };
  const retry = document.querySelector('[data-map-retry]');
  const ns = 'http://www.w3.org/2000/svg';
  const svgNode = (tag, attrs = {}) => {
    const node = document.createElementNS(ns, tag);
    Object.entries(attrs).forEach(([key, value]) => node.setAttribute(key, value));
    return node;
  };
  let states = [], counts = {};
  let pinIndex = 0;
  let lastLoadedAt = 0;
  let loading = false;
  const mapSection = canvas.closest('.paralegal-map');
  const revealObserver = new IntersectionObserver(entries => {
    canvas.classList.toggle('is-visible', entries[0].isIntersecting);
    if (entries[0].isIntersecting && lastLoadedAt && Date.now() - lastLoadedAt >= 5 * 60 * 1000) load();
  }, { threshold: .25 });
  revealObserver.observe(canvas);
  const reducedMotionPreference = matchMedia('(prefers-reduced-motion: reduce)');
  let parallaxFrame = 0;
  function updateParallax() {
    parallaxFrame = 0;
    if (reducedMotionPreference.matches) {
      canvas.style.setProperty('--map-parallax-y', '0px');
      return;
    }
    const rect = mapSection.getBoundingClientRect();
    const progress = Math.max(0, Math.min(1, (innerHeight - rect.top) / (innerHeight + rect.height)));
    const travel = innerWidth <= 600 ? 65 : 115;
    canvas.style.setProperty('--map-parallax-y', `${Math.round((.5 - progress) * travel * 2)}px`);
  }
  function scheduleParallax() {
    if (!parallaxFrame) parallaxFrame = requestAnimationFrame(updateParallax);
  }
  addEventListener('scroll', scheduleParallax, { passive: true });
  addEventListener('resize', scheduleParallax);
  reducedMotionPreference.addEventListener('change', scheduleParallax);
  async function load() {
    if (loading || (lastLoadedAt && Date.now() - lastLoadedAt < 5 * 60 * 1000)) return;
    loading = true;
    retry.hidden = true;
    if (!lastLoadedAt) statusElement.classList.remove('is-ready');
    canvas.setAttribute('aria-busy', 'true');
    try {
      const [geometryResponse, response] = await Promise.all([
        states.length ? Promise.resolve(null) : fetch('assets/data/us-states.json'),
        fetch('/api/public/paralegals/state-counts', { credentials: 'omit', signal: AbortSignal.timeout(15000) }),
      ]);
      if (geometryResponse) {
        if (!geometryResponse.ok) throw new Error('Map unavailable');
        const geometry = await geometryResponse.json();
        states = geometry.sort((a, b) => a.name.localeCompare(b.name));
      }
      if (!response.ok) throw new Error('Counts unavailable');
      const data = await response.json();
      if (!states.every(state => Number.isSafeInteger(data.states?.[state.code]) && data.states[state.code] >= 0)) throw new Error('Invalid counts');
      counts = data.states;
      const mappedTotal = states.reduce((sum, state) => sum + counts[state.code], 0);
      if (!Number.isSafeInteger(data.approvedTotal) || data.approvedTotal < mappedTotal) throw new Error('Invalid network total');
      render();
      canvas.classList.add('is-live');
      lastLoadedAt = Date.now();
      setStatus(data.approvedTotal.toLocaleString(), data.approvedTotal
        ? `paralegal${data.approvedTotal === 1 ? '' : 's'}`
        : 'paralegals in the network yet');
      growthElement.hidden = data.approvedTotal === 0;
      statusElement.classList.add('is-ready');
    } catch {
      if (!lastLoadedAt) {
        setStatus('—', 'Network locations are unavailable right now. Please try again shortly.');
        statusElement.classList.add('is-ready');
        retry.hidden = false;
      }
    } finally {
      loading = false;
      canvas.removeAttribute('aria-busy');
    }
  }
  function render() {
      pinIndex = 0;
      canvas.setAttribute('aria-busy', 'true');
      const previousSvg = canvas.querySelector('svg');
      const svg = svgNode('svg', { viewBox: '0 0 975 610', role: 'img', 'aria-label': 'US paralegal network. Each pin represents an approved paralegal in that state.' });
      svg.style.visibility = 'hidden';
      const outlines = svgNode('g', { class: 'paralegal-map__outlines' });
      const pinGroups = document.createDocumentFragment();
      svg.append(outlines);
      canvas.append(svg);
      scheduleParallax();
      for (const state of states) {
        const outline = svgNode('path', { d: state.path, 'data-state': state.code });
        outlines.append(outline);
        const count = counts[state.code] || 0;
        if (!count) continue;
        const group = svgNode('g', { class: 'paralegal-map__pins', 'data-state': state.code, 'aria-label': `${state.name}: ${count} approved paralegals`, role: 'img' });
        const box = outline.getBBox();
        const points = [];
        // Seeded random positions avoid rows and diagonals while staying stable on refresh.
        let seed = state.code.charCodeAt(0) * 65537 + state.code.charCodeAt(1);
        const random = () => {
          seed = (seed + 0x6D2B79F5) | 0;
          let value = Math.imul(seed ^ (seed >>> 15), 1 | seed);
          value ^= value + Math.imul(value ^ (value >>> 7), 61 | value);
          return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
        };
        // No member coordinates are requested or exposed.
        for (let attempt = 1; points.length < count && attempt <= Math.max(5000, count * 100); attempt++) {
          const point = svg.createSVGPoint();
          point.x = box.x + random() * box.width;
          point.y = box.y + random() * box.height;
          if (outline.isPointInFill(point)) points.push([point.x, point.y]);
        }
        // Keep dots within their state without a large geometry search on mobile.
        const probe = svg.createSVGPoint();
        const hasClearance = ([x, y], radius) => {
          for (let step = 0; step < 12; step++) {
            const angle = step * Math.PI / 6;
            probe.x = x + Math.cos(angle) * radius;
            probe.y = y + Math.sin(angle) * radius;
            if (!outline.isPointInFill(probe)) return false;
          }
          return true;
        };
        const maxRadius = innerWidth <= 600 ? 4.5 : 3.4;
        points.forEach(point => {
          let [x, y] = point;
          let radius = maxRadius;
          if (!hasClearance(point, radius)) {
            for (let attempt = 0; attempt < 80; attempt++) {
              const candidate = [box.x + random() * box.width, box.y + random() * box.height];
              probe.x = candidate[0]; probe.y = candidate[1];
              if (outline.isPointInFill(probe) && hasClearance(candidate, radius)) {
                [x, y] = candidate;
                break;
              }
            }
            while (radius > .8 && !hasClearance([x, y], radius)) radius *= .7;
          }
          const pin = svgNode('g', { transform: `translate(${x.toFixed(2)} ${y.toFixed(2)})`, class: 'paralegal-map__pin', 'aria-hidden': 'true' });
          if (pinIndex % 13 === 0) {
            const halo = svgNode('circle', { cx: 0, cy: 0, r: radius, class: 'paralegal-map__halo' });
            halo.style.setProperty('--pulse-delay', `${-((pinIndex % 5) * 1.2).toFixed(1)}s`);
            pin.append(halo);
          }
          const dot = svgNode('circle', { cx: 0, cy: 0, r: radius, class: 'paralegal-map__dot' });
          dot.style.setProperty('--reveal-delay', `${Math.round(x / 975 * 900 + y / 610 * 120)}ms`);
          pin.append(dot);
          group.append(pin);
          pinIndex++;
        });
        pinGroups.append(group);
      }
      svg.append(pinGroups);
      svg.style.visibility = '';
      if (previousSvg) previousSvg.remove();
      scheduleParallax();
  }
  retry.addEventListener('click', load);
  // Start data work after the first hero frame, well before a normal scroll reaches the map.
  setTimeout(() => void load(), 700);
  // A quick scroll should start the request immediately rather than wait for the timer.
  if ('IntersectionObserver' in window) {
    const loadObserver = new IntersectionObserver(entries => {
      if (!entries.some(entry => entry.isIntersecting)) return;
      loadObserver.disconnect();
      void load();
    }, { rootMargin: '600px 0px' });
    loadObserver.observe(mapSection);
  }
})();
