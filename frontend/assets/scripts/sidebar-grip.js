(function initializeSidebarGrip() {
  const DESKTOP_BREAKPOINT = 1024;

  function init() {
    const sidebar = document.getElementById("sidebarNav") || document.querySelector(".sidebar");
    if (!sidebar || document.querySelector(".lpc-sidebar-grip")) return;

    const button = document.createElement("button");
    button.type = "button";
    button.className = "lpc-sidebar-grip";
    button.setAttribute("aria-controls", sidebar.id || "sidebarNav");

    const line = document.createElement("span");
    line.className = "lpc-sidebar-grip__line";
    line.setAttribute("aria-hidden", "true");

    const label = document.createElement("span");
    label.className = "lpc-sidebar-grip__label";

    button.append(line, label);
    document.body.appendChild(button);

    const sync = () => {
      if (window.innerWidth <= DESKTOP_BREAKPOINT) {
        document.documentElement.style.removeProperty("--lpc-sidebar-grip-left");
        return;
      }

      const collapsed = document.body.classList.contains("nav-collapsed");
      const sidebarRight = sidebar.getBoundingClientRect().right;
      document.documentElement.style.setProperty(
        "--lpc-sidebar-grip-left",
        `${Math.round(sidebarRight - 14)}px`
      );
      const action = collapsed ? "Expand" : "Collapse";
      label.textContent = action;
      button.setAttribute("aria-label", `${action} sidebar`);
      button.setAttribute("aria-expanded", String(!collapsed));
      sidebar.querySelectorAll(".lpc-sidebar-nav-link").forEach((link) => {
        const linkLabel = link.querySelector(".lpc-sidebar-nav-label")?.textContent?.trim();
        if (collapsed && linkLabel) link.setAttribute("title", linkLabel);
        else link.removeAttribute("title");
      });
    };

    button.addEventListener("click", () => {
      if (window.innerWidth <= DESKTOP_BREAKPOINT) return;
      document.body.classList.toggle("nav-collapsed");
      document.body.classList.remove("nav-open");
      sync();
    });

    window.addEventListener("resize", sync);
    if ("ResizeObserver" in window) new ResizeObserver(sync).observe(sidebar);
    sync();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }
})();
