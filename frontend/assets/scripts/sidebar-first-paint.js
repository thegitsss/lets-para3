(function hydrateSidebarIdentityBeforeFirstPaint() {
  const trigger = document.querySelector("#sidebarNav [data-lpc-sidebar-profile-trigger]");
  if (!trigger) return;
  try {
    const user = JSON.parse(localStorage.getItem("lpc_user") || "null");
    if (!user || typeof user !== "object") return;
    const name = `${user.firstName || ""} ${user.lastName || ""}`.trim() || user.name || "Member";
    const avatar = user.pendingProfileImage || user.profileImage || user.avatarURL || "assets/avatar-placeholder.svg";
    const nameNode = trigger.querySelector(".globalProfileName");
    const image = trigger.querySelector(".globalProfileImage");
    if (nameNode) nameNode.textContent = name;
    if (image) {
      image.dataset.sidebarAvatarFallbackBound = "true";
      image.addEventListener("error", () => {
        const fallback = new URL("assets/avatar-placeholder.svg", document.baseURI).href;
        if (image.src !== fallback) image.src = fallback;
      });
      image.src = avatar;
    }
  } catch (_) {}
})();
