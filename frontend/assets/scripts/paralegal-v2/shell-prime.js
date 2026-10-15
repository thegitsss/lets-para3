(function primeUnverifiedParalegalV2Shell() {
  "use strict";

  // Cached preferences may style the shell, but cached identity cannot reveal
  // a name or request a private avatar before the session is verified.
  if (document.body.dataset.v2Session === "ready") return;

  const nameNode = document.querySelector("[data-v2-profile-name]");
  if (nameNode) nameNode.textContent = "Member";

  const avatar = document.querySelector("[data-v2-profile-avatar]");
  if (avatar) avatar.src = "/assets/avatar-placeholder.svg";
})();
