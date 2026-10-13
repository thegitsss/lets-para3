(() => {
  "use strict";

  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

  class PublicMatterField {
    constructor(section) {
      this.section = section;
      this.host = section.querySelector("[data-matter-field-host]") || section;
      this.canvas = document.createElement("canvas");
      this.canvas.className = "hero-banner__matter-field";
      this.canvas.setAttribute("aria-hidden", "true");
      this.context = this.canvas.getContext("2d", { alpha: true });
      this.width = 0;
      this.height = 0;
      this.nodes = [];
      this.running = false;
      this.visible = true;
      this.frame = 0;

      if (!this.context) return;

      this.host.prepend(this.canvas);
      this.resize = this.resize.bind(this);
      this.animate = this.animate.bind(this);

      if ("ResizeObserver" in window) {
        this.resizeObserver = new ResizeObserver(this.resize);
        this.resizeObserver.observe(this.host);
      } else {
        window.addEventListener("resize", this.resize, { passive: true });
      }

      if ("IntersectionObserver" in window) {
        this.visibilityObserver = new IntersectionObserver(
          (entries) => {
            this.visible = Boolean(entries[0]?.isIntersecting);
            if (this.visible) this.start();
          },
          { rootMargin: "160px 0px", threshold: 0 }
        );
        this.visibilityObserver.observe(this.section);
      }

      this.resize();
      this.start();
    }

    randomFactory(seed) {
      let value = seed >>> 0;
      return () => {
        value = (value * 1664525 + 1013904223) >>> 0;
        return value / 4294967296;
      };
    }

    buildNodes() {
      const random = this.randomFactory(650);
      const labels = ["SCOPE", "FILES", "DEADLINE", "PEOPLE", "MESSAGES", "PAYMENT"];
      const count = this.width < 680 ? 32 : 58;

      this.nodes = Array.from({ length: count }, (_, index) => {
        const angle = random() * Math.PI * 2;
        const radiusX = this.width * (0.3 + random() * 0.19);
        const radiusY = this.height * (0.28 + random() * 0.22);
        return {
          baseX: this.width * 0.5 + Math.cos(angle) * radiusX,
          baseY: this.height * 0.5 + Math.sin(angle) * radiusY,
          radius: 0.7 + random() * 1.7,
          phase: random() * Math.PI * 2,
          speed: 0.18 + random() * 0.4,
          featured: index < labels.length && this.width > 760,
          label: labels[index] || "",
        };
      });
    }

    resize() {
      const rect = this.host.getBoundingClientRect();
      const width = Math.max(1, Math.round(rect.width));
      const height = Math.max(1, Math.round(rect.height));
      const dpr = Math.min(window.devicePixelRatio || 1, 1.5);

      if (
        width === this.width &&
        height === this.height &&
        this.canvas.width === Math.round(width * dpr)
      ) {
        return;
      }

      this.width = width;
      this.height = height;
      this.canvas.width = Math.round(width * dpr);
      this.canvas.height = Math.round(height * dpr);
      this.canvas.style.width = `${width}px`;
      this.canvas.style.height = `${height}px`;
      this.context.setTransform(dpr, 0, 0, dpr, 0, 0);
      this.buildNodes();
      this.render(0);
    }

    render(time) {
      const context = this.context;
      const width = this.width;
      const height = this.height;
      if (!width || !height) return;

      context.clearRect(0, 0, width, height);
      const positions = this.nodes.map((node) => ({
        x: node.baseX + Math.sin(time * node.speed + node.phase) * 7,
        y: node.baseY + Math.cos(time * node.speed * 0.8 + node.phase) * 5,
      }));

      positions.forEach((position, index) => {
        const next = positions[(index + 1) % positions.length];
        context.beginPath();
        context.moveTo(position.x, position.y);
        context.lineTo(next.x, next.y);
        context.strokeStyle = `rgba(77, 89, 107, ${index % 4 === 0 ? 0.11 : 0.045})`;
        context.lineWidth = 0.65;
        context.stroke();
      });

      this.nodes.forEach((node, index) => {
        const position = positions[index];
        if (node.featured) {
          context.save();
          context.font = '500 9px "Sarabun", sans-serif';
          context.textAlign = "center";
          context.fillStyle = "rgba(128, 101, 44, 0.52)";
          context.fillText(node.label, position.x, position.y + 17);
          context.restore();
        }

        context.beginPath();
        context.arc(position.x, position.y, node.radius, 0, Math.PI * 2);
        context.fillStyle =
          index % 5 === 0
            ? "rgba(180, 151, 90, 0.55)"
            : "rgba(58, 72, 92, 0.28)";
        context.fill();
      });

      const ring = context.createRadialGradient(
        width * 0.5,
        height * 0.5,
        Math.min(70, height * 0.25),
        width * 0.5,
        height * 0.5,
        width * 0.47
      );
      ring.addColorStop(0, "rgba(255, 255, 255, 0)");
      ring.addColorStop(0.58, "rgba(180, 151, 90, 0.025)");
      ring.addColorStop(1, "rgba(180, 151, 90, 0.12)");
      context.fillStyle = ring;
      context.fillRect(0, 0, width, height);
    }

    start() {
      if (this.running || !this.visible) return;
      if (reducedMotion.matches) {
        this.render(0);
        return;
      }
      this.running = true;
      this.frame = requestAnimationFrame(this.animate);
    }

    animate(time) {
      if (!this.visible || document.hidden) {
        this.running = false;
        return;
      }
      this.render(time * 0.001);
      this.frame = requestAnimationFrame(this.animate);
    }
  }

  const initialize = () => {
    document.querySelectorAll(".hero-banner").forEach((section) => {
      if (!section.querySelector(".hero-banner__matter-field")) {
        new PublicMatterField(section);
      }
    });
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initialize, { once: true });
  } else {
    initialize();
  }
})();
