(() => {
  "use strict";

  const canvas = document.querySelector("[data-auth-matter-field]");
  const host = canvas?.closest(".overlay");
  const context = canvas?.getContext("2d", { alpha: true });
  if (!canvas || !host || !context) return;

  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  const isNavyAuth = document.body.classList.contains("signup-page") || document.body.classList.contains("login-page") || document.body.classList.contains("verify-email-page") || document.body.classList.contains("password-recovery-page");
  const labels = ["SCOPE", "FILES", "DEADLINE", "PEOPLE", "MESSAGES", "PAYMENT"];
  let width = 0;
  let height = 0;
  let nodes = [];
  let frame = 0;
  let visible = true;

  const randomFactory = (seed) => {
    let value = seed >>> 0;
    return () => {
      value = (value * 1664525 + 1013904223) >>> 0;
      return value / 4294967296;
    };
  };

  const buildNodes = () => {
    const random = randomFactory(650);
    const count = width < 680 ? 32 : 58;

    nodes = Array.from({ length: count }, (_, index) => {
      const angle = random() * Math.PI * 2;
      const radiusX = width * (0.3 + random() * 0.19);
      const radiusY = height * (0.28 + random() * 0.22);
      return {
        baseX: width * 0.5 + Math.cos(angle) * radiusX,
        baseY: height * 0.5 + Math.sin(angle) * radiusY,
        radius: 0.7 + random() * 1.7,
        phase: random() * Math.PI * 2,
        speed: 0.23 + random() * 0.48,
        featured: index < labels.length && width > 760,
        label: labels[index] || "",
      };
    });
  };

  const resize = () => {
    const rect = host.getBoundingClientRect();
    const nextWidth = Math.max(1, Math.round(rect.width));
    const nextHeight = Math.max(1, Math.round(rect.height));
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    if (
      nextWidth === width &&
      nextHeight === height &&
      canvas.width === Math.round(nextWidth * dpr)
    ) {
      return;
    }

    width = nextWidth;
    height = nextHeight;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    buildNodes();
  };

  const render = (time) => {
    if (!width || !height) return;
    context.clearRect(0, 0, width, height);

    const positions = nodes.map((node) => ({
      x: node.baseX + Math.sin(time * node.speed + node.phase) * 9,
      y: node.baseY + Math.cos(time * node.speed * 0.8 + node.phase) * 7,
    }));

    positions.forEach((position, index) => {
      const next = positions[(index + 1) % positions.length];
      context.beginPath();
      context.moveTo(position.x, position.y);
      context.lineTo(next.x, next.y);
      context.strokeStyle = isNavyAuth
        ? `rgba(225, 230, 235, ${index % 4 === 0 ? 0.14 : 0.06})`
        : `rgba(67, 79, 97, ${index % 4 === 0 ? 0.15 : 0.065})`;
      context.lineWidth = 0.85;
      context.stroke();
    });

    nodes.forEach((node, index) => {
      const position = positions[index];
      if (node.featured) {
        context.save();
        context.font = '500 9px "Sarabun", sans-serif';
        context.textAlign = "center";
        context.fillStyle = isNavyAuth ? "rgba(201, 178, 128, 0.58)" : "rgba(128, 101, 44, 0.52)";
        context.fillText(node.label, position.x, position.y + 17);
        context.restore();
      }
      context.beginPath();
      context.arc(position.x, position.y, node.radius, 0, Math.PI * 2);
      context.fillStyle =
        index % 5 === 0
          ? "rgba(180, 151, 90, 0.55)"
          : isNavyAuth
            ? "rgba(220, 227, 234, 0.3)"
            : "rgba(58, 72, 92, 0.28)";
      context.fill();
    });

    const ring = context.createRadialGradient(
      width * 0.5,
      height * 0.5,
      70,
      width * 0.5,
      height * 0.5,
      width * 0.47
    );
    ring.addColorStop(0, "rgba(255, 255, 255, 0)");
    ring.addColorStop(0.58, "rgba(180, 151, 90, 0.025)");
    ring.addColorStop(1, "rgba(180, 151, 90, 0.12)");
    context.fillStyle = ring;
    context.fillRect(0, 0, width, height);
  };

  const animate = (timestamp) => {
    if (!visible || document.hidden) return;
    render(timestamp * 0.001);
    frame = requestAnimationFrame(animate);
  };

  const start = () => {
    cancelAnimationFrame(frame);
    resize();
    if (reducedMotion.matches) {
      render(0);
      return;
    }
    frame = requestAnimationFrame(animate);
  };

  new ResizeObserver(resize).observe(host);
  new IntersectionObserver(
    ([entry]) => {
      visible = Boolean(entry?.isIntersecting);
      if (visible) start();
      else cancelAnimationFrame(frame);
    },
    { rootMargin: "120px 0px", threshold: 0 }
  ).observe(host);

  reducedMotion.addEventListener?.("change", start);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && visible) start();
  });
  start();
})();
