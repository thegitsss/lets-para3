(function(){
  const FALLBACK_AVATAR = `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(
    `<svg xmlns='http://www.w3.org/2000/svg' width='220' height='220' viewBox='0 0 220 220'>
      <rect width='220' height='220' rx='110' fill='#f1f5f9'/>
      <circle cx='110' cy='90' r='46' fill='#cbd5e1'/>
      <path d='M40 188c10-40 45-68 70-68s60 28 70 68' fill='none' stroke='#cbd5e1' stroke-width='18' stroke-linecap='round'/>
    </svg>`
  )}`;
  let hydrated = false;
  let stylesInjected = false;
  let baseStylesInjected = false;
  let pendingStylesInjected = false;

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

  function ensurePendingBannerStyles(){
    if (pendingStylesInjected) return;
    pendingStylesInjected = true;
    const style = document.createElement("style");
    style.textContent = `
      .pending-approval-banner{
        display:flex;
        align-items:center;
        gap:12px;
        padding:12px 16px;
        margin:0 0 1.25rem;
        border-radius:12px;
        background:#fff6e5;
        border:1px solid #e6cf9a;
        color:#5b4212;
        font-size:0.95rem;
        font-weight:200;
        box-shadow:0 10px 24px rgba(0,0,0,0.05);
      }
      .pending-approval-banner strong{
        font-family:'Cormorant Garamond',serif;
        font-weight:300;
        font-size:1.05rem;
      }
      .pending-approval-banner.hidden{
        display:none;
      }
    `;
    document.head.appendChild(style);
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
      #paralegalFloatingCluster [data-notification-toggle][data-count]:after{
        content:attr(data-count);
        position:absolute;
        top:-4px;
        right:-4px;
        background:#b4975a;
        color:#fff;
        font-family:'Sarabun',sans-serif;
        font-weight:200;
        font-size:0.7rem;
        padding:2px 6px;
        border-radius:999px;
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
      #paralegalFloatingCluster .notif-panel{
        position:absolute;
        right:0;
        top:48px;
        width:320px;
        padding:0;
        background:#fff;
        border:1px solid rgba(12,18,37,0.08);
        border-radius:12px;
        display:none;
        flex-direction:column;
        box-shadow:0 18px 45px rgba(0,0,0,0.12);
      }
      #paralegalFloatingCluster .notif-panel.show{display:flex;}
      #paralegalFloatingCluster .notif-panel.hidden{display:none;}
      #paralegalFloatingCluster .notif-header{
        font-family:'Cormorant Garamond',serif;
        font-weight:300;
        font-size:1.15rem;
        padding:12px 16px;
        border-bottom:1px solid rgba(0,0,0,0.08);
        background:#fafafa;
      }
      #paralegalFloatingCluster #notifList{
        max-height:220px;
        overflow-y:auto;
      }
      #paralegalFloatingCluster .notif-item{
        padding:12px 16px;
        border-bottom:1px solid rgba(0,0,0,0.06);
      }
      #paralegalFloatingCluster .notif-item:last-child{border-bottom:none;}
      #paralegalFloatingCluster .notif-item.unread{border-left:3px solid #b4975a;}
      #paralegalFloatingCluster .notif-title{
        font-family:'Cormorant Garamond',serif;
        font-weight:300;
        font-size:1.05rem;
        margin-bottom:2px;
      }
      #paralegalFloatingCluster .notif-body{
        font-family:'Sarabun',sans-serif;
        font-weight:200;
        font-size:0.88rem;
        color:#5c6475;
      }
      #paralegalFloatingCluster .notif-time{
        font-size:0.75rem;
        color:#9aa0b0;
        margin-top:4px;
      }
      #paralegalFloatingCluster .notif-empty{
        padding:16px;
        text-align:center;
        color:#7c8295;
        font-size:0.88rem;
      }
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
      <div id="notificationPanel" class="notif-panel hidden" data-notification-panel>
        <div class="notif-header">Notifications</div>
        <div id="notifList" data-notification-list></div>
        <div class="notif-empty" data-notification-empty>Loading…</div>
        <button id="markAllReadBtn" class="notif-markall" type="button" data-notification-mark>Mark All Read</button>
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
    return "";
  }

  function isPendingPhoto(user = {}){
    return (
      String(user.profilePhotoStatus || "").toLowerCase() === "pending_review" ||
      Boolean(user.pendingProfileImage)
    );
  }

  function applyGlobalAvatars(user = {}) {
    const avatar = user.pendingProfileImage || user.profileImage || user.avatarURL || "";
    if (!avatar) return;
    const targets = document.querySelectorAll("#user-avatar, #headerAvatar, #avatarPreview");
    targets.forEach((el) => {
      if (el) el.src = avatar;
    });
  }

  function findPendingBannerHost(){
    return (
      document.querySelector("main#main") ||
      document.querySelector("main") ||
      document.querySelector(".main") ||
      document.querySelector("[role='main']") ||
      document.body
    );
  }

  function ensurePendingBanner(){
    let banner = document.getElementById("pendingApprovalBanner");
    if (!banner) {
      banner = document.createElement("div");
      banner.id = "pendingApprovalBanner";
      banner.className = "pending-approval-banner hidden";
      banner.setAttribute("role", "status");
      banner.setAttribute("aria-live", "polite");
      banner.innerHTML = `
        <strong>Pending Approval</strong>
        <span>Your profile photo is under review and visible only to you.</span>
      `;
    }
    if (!banner.parentElement) {
      const host = findPendingBannerHost();
      if (host) {
        const header = Array.from(host.children || []).find((el) => el.tagName === "HEADER");
        if (header) {
          header.insertAdjacentElement("afterend", banner);
        } else {
          host.insertAdjacentElement("afterbegin", banner);
        }
      }
    }
    return banner;
  }

  function renderPendingBanner(user = {}){
    const isParalegal = String(user.role || "").toLowerCase() === "paralegal";
    const pending = isParalegal && isPendingPhoto(user);
    const banner = document.getElementById("pendingApprovalBanner");
    if (!pending) {
      if (banner) banner.classList.add("hidden");
      return;
    }
    ensurePendingBannerStyles();
    ensurePendingBanner().classList.remove("hidden");
  }

  function renderUserFields(user = {}){
    const els = targetEls();
    if (!hasTargets()) return;
    if (els.name) els.name.textContent = formatName(user);
    if (els.role) {
      const roleText = formatRole(user);
      const pending = isPendingPhoto(user);
      const displayText = pending
        ? roleText
          ? `${roleText} · PENDING`
          : "PENDING"
        : roleText;
      els.role.textContent = displayText;
      els.role.style.display = displayText ? "" : "none";
    }
    const avatar = user.pendingProfileImage || user.profileImage || user.avatarURL || FALLBACK_AVATAR;
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
    applyGlobalAvatars(user);
    renderPendingBanner(user);
  }

  function hydrate(user={}){
    renderUserFields(user);
    hydrated = true;
    window.__paralegalClusterHydrated = true;
  }

  function applyStoredUser(){
    try{
      const stored = localStorage.getItem("lpc_user");
      if (!stored) return;
      const parsed = JSON.parse(stored);
      if (parsed && typeof parsed === "object") renderUserFields(parsed);
    }catch(_){}
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
  document.addEventListener("DOMContentLoaded", () => {
    applyStoredUser();
    loadCluster();
  });
})();
