(() => {
  const canvas = document.querySelector('[data-paralegal-map]');
  if (!canvas) return;
  const summaryElement = document.querySelector('[data-map-summary]');
  const growthElement = document.querySelector('[data-map-growth]');
  const totalElement = document.querySelector('[data-map-total]');
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
    const svg = canvas.querySelector('svg');
    if (!svg) return;
    if (reducedMotionPreference.matches) {
      svg.style.setProperty('--map-parallax-y', '0px');
      return;
    }
    const rect = mapSection.getBoundingClientRect();
    const progress = Math.max(0, Math.min(1, (innerHeight - rect.top) / (innerHeight + rect.height)));
    const travel = innerWidth <= 600 ? 65 : 115;
    svg.style.setProperty('--map-parallax-y', `${Math.round((.5 - progress) * travel * 2)}px`);
  }
  function scheduleParallax() {
    if (!parallaxFrame) parallaxFrame = requestAnimationFrame(updateParallax);
  }
  addEventListener('scroll', scheduleParallax, { passive: true });
  addEventListener('resize', scheduleParallax);
  reducedMotionPreference.addEventListener('change', scheduleParallax);
  async function load() {
    if (loading) return;
    loading = true;
    retry.hidden = true;
    if (!lastLoadedAt) setStatus('—', 'Loading the map…');
    try {
      if (!states.length) {
        const geometryResponse = await fetch('assets/data/us-states.json');
        if (!geometryResponse.ok) throw new Error('Map unavailable');
        const geometry = await geometryResponse.json();
        states = geometry.sort((a, b) => a.name.localeCompare(b.name));
        render();
      }
      const response = await fetch('/api/public/paralegals/state-counts', { credentials: 'omit', signal: AbortSignal.timeout(15000) });
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
    } catch {
      if (!lastLoadedAt) {
        setStatus('—', 'Network locations are unavailable right now. Please try again shortly.');
        retry.hidden = false;
      }
    } finally {
      loading = false;
    }
  }
  function render() {
      pinIndex = 0;
      canvas.classList.remove('is-live');
      const svg = svgNode('svg', { viewBox: '0 0 975 610', role: 'img', 'aria-label': 'US paralegal network. Each pin represents an approved paralegal in that state.' });
      const outlines = svgNode('g', { class: 'paralegal-map__outlines' });
      svg.append(outlines);
      canvas.replaceChildren(svg);
      scheduleParallax();
      states.forEach(state => {
        const outline = svgNode('path', { d: state.path, 'data-state': state.code });
        outlines.append(outline);
        const count = counts[state.code] || 0;
        if (!count) return;
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
        // Preserve existing positions where possible; relocate only dots near an edge.
        const probe = svg.createSVGPoint();
        const hasClearance = ([x, y], inset) => {
          for (const radius of [0, inset * .5, inset]) {
            for (let step = 0; step < 16; step++) {
              const angle = step * Math.PI / 8;
              probe.x = x + Math.cos(angle) * radius;
              probe.y = y + Math.sin(angle) * radius;
              if (!outline.isPointInFill(probe)) return false;
            }
          }
          return true;
        };
        const candidates = points.slice();
        for (let attempt = 0; attempt < 2400 && candidates.length < count + 600; attempt++) {
          const candidate = [box.x + random() * box.width, box.y + random() * box.height];
          probe.x = candidate[0]; probe.y = candidate[1];
          if (outline.isPointInFill(probe)) candidates.push(candidate);
        }
        let inset = 10;
        let interior = candidates.filter(point => hasClearance(point, inset));
        // Narrow states receive the largest feasible inset and proportionally smaller dots.
        while (!interior.length && inset > .5) {
          inset *= .8;
          interior = candidates.filter(point => hasClearance(point, inset));
        }
        const placed = [];
        points.forEach((point, index) => {
          if (!hasClearance(point, inset) && interior.length) {
            const sorted = interior.slice().sort((a, b) => Math.hypot(a[0] - point[0], a[1] - point[1])
              - Math.hypot(b[0] - point[0], b[1] - point[1]));
            point = sorted.find(candidate => placed.every(other =>
              Math.hypot(candidate[0] - other[0], candidate[1] - other[1]) >= Math.min(7, inset))) || sorted[0];
            points[index] = point;
          }
          placed.push(point);
        });
        points.forEach(([x, y]) => {
          const pin = svgNode('g', { transform: `translate(${x.toFixed(2)} ${y.toFixed(2)})`, class: 'paralegal-map__pin', 'aria-hidden': 'true' });
          const radius = Math.min(innerWidth <= 600 ? 4.5 : 3.4, inset * .5);
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
        svg.append(group);
      });

  }
  retry.addEventListener('click', load);
  load();
})();
