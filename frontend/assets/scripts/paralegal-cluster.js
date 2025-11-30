(function(){
  const FALLBACK_AVATAR = "https://via.placeholder.com/120x120.png?text=PL";
  let hydrated = false;
  let stylesInjected = false;
  let baseStylesInjected = false;

  function targetEls(){
    return {
      name: document.getElementById("clusterName") || document.getElementById("headerName"),
      role: document.getElementById("clusterRole") || document.getElementById("headerRole"),
      avatar: document.getElementById("clusterAvatar") || document.getElementById("headerAvatar") || document.querySelector(".nav-profile-photo"),
      badge: document.getElementById("notificationBadge") || document.querySelector("[data-notification-badge]"),
    };
  }

  function hasTargets(){
    const { name, role, avatar, badge } = targetEls();
    return !!(name || role || avatar || badge);
  }

  function ensureBadgeStyles(){
    if (!baseStylesInjected) {
      baseStylesInjected = true;
      const base = document.createElement("style");
      base.textContent = `
        .notification-badge{display:none;}
        .notification-badge.show{display:flex;}
      `;
      document.head.appendChild(base);
    }
  }

  function injectFloatingStyles(){
    ensureBadgeStyles();
    if (stylesInjected) return;
    stylesInjected = true;
    const style = document.createElement("style");
    style.textContent = `
      #paralegalFloatingCluster{
        position:fixed;
        top:16px;
        right:16px;
        display:flex;
        align-items:center;
        gap:10px;
        padding:8px 12px;
        background:#fff;
        border:1px solid rgba(12,18,37,0.08);
        border-radius:14px;
        box-shadow:0 14px 40px rgba(0,0,0,0.1);
        z-index:1200;
      }
      #paralegalFloatingCluster .notification-icon{
        width:40px;
        height:40px;
        border-radius:50%;
        border:1px solid rgba(12,18,37,0.08);
        display:flex;
        align-items:center;
        justify-content:center;
        background:#fff;
        position:relative;
        cursor:pointer;
      }
      #paralegalFloatingCluster .notification-badge{
        position:absolute;
        top:-6px;
        right:-6px;
        width:18px;
        height:18px;
        border-radius:50%;
        background:#e63946;
        color:#fff;
        font-size:0.7rem;
        display:flex;
        align-items:center;
        justify-content:center;
        font-weight:700;
      }
      #paralegalFloatingCluster .user-profile{
        display:flex;
        align-items:center;
        gap:8px;
      }
      #paralegalFloatingCluster .user-profile strong{display:block;font-weight:500;}
      #paralegalFloatingCluster .user-profile span{display:block;font-size:0.85rem;color:#5c6475;font-weight:200;}
      #paralegalFloatingCluster img{
        width:42px;
        height:42px;
        border-radius:50%;
        object-fit:cover;
        box-shadow:0 6px 16px rgba(0,0,0,0.1);
      }
      #paralegalFloatingCluster .notification-panel{
        position:absolute;
        right:0;
        top:calc(100% + 10px);
        width:280px;
        padding:14px;
        background:#fff;
        border:1px solid rgba(12,18,37,0.08);
        border-radius:14px;
        box-shadow:0 10px 30px rgba(0,0,0,0.12);
        display:none;
      }
      #paralegalFloatingCluster .notification-panel.show{display:block;}
      #paralegalFloatingCluster .notification-panel-header{
        display:flex;
        align-items:center;
        justify-content:space-between;
        margin-bottom:8px;
        font-size:0.92rem;
      }
      #paralegalFloatingCluster .notification-panel-header button{
        border:none;
        background:none;
        color:#d19c3a;
        cursor:pointer;
        font-size:0.85rem;
      }
      #paralegalFloatingCluster [data-notification-list]{list-style:none;padding:0;margin:0;display:flex;flex-direction:column;gap:8px;}
      #paralegalFloatingCluster [data-notification-list] li{
        border:1px solid rgba(12,18,37,0.08);
        border-radius:12px;
        padding:10px;
        background:#fcfcfc;
      }
      #paralegalFloatingCluster [data-notification-list] li strong{display:block;font-weight:500;margin-bottom:4px;}
      #paralegalFloatingCluster [data-notification-list] li span{display:block;font-size:0.8rem;color:#5c6475;}
      #paralegalFloatingCluster [data-notification-empty]{font-size:0.85rem;color:#5c6475;}
      #paralegalFloatingCluster .notification-badge{display:none;}
      #paralegalFloatingCluster .notification-badge.show{display:flex;}
    `;
    document.head.appendChild(style);
  }

  function mountFloatingCluster(){
    injectFloatingStyles();
    if (document.getElementById("paralegalFloatingCluster")) return;
    const wrap = document.createElement("div");
    wrap.id = "paralegalFloatingCluster";
    wrap.setAttribute("data-notification-center","true");
    wrap.style.position = "fixed";
    wrap.style.top = "16px";
    wrap.style.right = "16px";
    wrap.innerHTML = `
      <button class="notification-icon" aria-label="View notifications" data-notification-toggle>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M18 8a6 6 0 10-12 0c0 7-3 9-3 9h18s-3-2-3-9"></path>
          <path d="M13.73 21a2 2 0 01-3.46 0"></path>
        </svg>
        <span class="notification-badge" id="notificationBadge" data-notification-badge>0</span>
      </button>
      <div class="user-profile">
        <img id="clusterAvatar" class="nav-profile-photo" src="${FALLBACK_AVATAR}" alt="Paralegal avatar" />
        <div>
          <strong id="clusterName">Paralegal</strong>
          <span id="clusterRole">Logged in</span>
        </div>
      </div>
      <div class="notification-panel" data-notification-panel>
        <div class="notification-panel-header">
          <h4 style="margin:0;font-size:0.95rem;">Notifications</h4>
          <button type="button" data-notification-mark>Mark all read</button>
        </div>
        <ul data-notification-list></ul>
        <p class="notification-item" data-notification-empty>Loading…</p>
      </div>
    `;
    document.body.appendChild(wrap);
    window.scanNotificationCenters?.();
  }

  function formatName(user={}){
    const combined = `${user.firstName || ""} ${user.lastName || ""}`.trim();
    return combined || user.name || "Paralegal";
  }

  function formatRole(user={}){
    if (user.title) return user.title;
    if (user.role) return String(user.role).charAt(0).toUpperCase() + String(user.role).slice(1);
    return "Paralegal";
  }

  function hydrate(user={}){
    const els = targetEls();
    if (!hasTargets()) return;
    hydrated = true;
    window.__paralegalClusterHydrated = true;
    if (els.name) els.name.textContent = formatName(user);
    if (els.role) els.role.textContent = formatRole(user);
    const avatar = user.profileImage || user.avatarURL || FALLBACK_AVATAR;
    if (els.avatar && avatar) {
      els.avatar.src = avatar;
      els.avatar.alt = `${formatName(user)} avatar`;
    }
    if (els.badge) {
      const count = typeof user.unreadNotifications === "number" ? user.unreadNotifications : 0;
      const label = count > 9 ? "9+" : String(count || 0);
      els.badge.textContent = label;
      els.badge.classList.toggle("show", count > 0);
    }
  }

  async function loadCluster(){
    ensureBadgeStyles();
    if (hydrated || window.__paralegalClusterHydrated) return;
    if (!hasTargets()) {
      mountFloatingCluster();
    }
    if (!hasTargets()) return;
    try{
      const res = await fetch("/api/users/me", { credentials:"include" });
      const user = res.ok ? await res.json() : {};
      hydrate(user || {});
    }catch(err){
      hydrate({});
    }
  }

  window.hydrateParalegalCluster = hydrate;
  document.addEventListener("DOMContentLoaded", loadCluster);
})();
