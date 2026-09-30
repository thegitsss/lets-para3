const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "../..");
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");

const authenticatedSurfaces = [
  "frontend/dashboard-paralegal.html",
  "frontend/browse-jobs.html",
  "frontend/profile-paralegal.html",
  "frontend/profile-settings.html",
  "frontend/case-detail.html",
];

describe("paralegal V2 Phase 1 authenticated shell contract", () => {
  test.each(authenticatedSurfaces)("%s ships the shared shell before hydration", (file) => {
    const html = read(file);
    expect(html).toMatch(/class="[^"]*lpc-static-universal-header/);
    expect(html).toMatch(/class="[^"]*lpc-auth-page-shell/);
    expect(html).toMatch(/data-lpc-universal-header="true"/);
    expect(html).toMatch(/class="lpc-universal-header-controls"[^>]*data-notification-center="true"/);
    expect(html).toMatch(/data-productivity-trigger-host/);
    expect(html).toMatch(/data-notification-toggle/);
    expect(html).toMatch(/class="logo sidebar-profile-host"/);
    expect(html).toMatch(/data-lpc-sidebar-profile-trigger/);
    expect(html).toMatch(/class="globalProfileImage lpc-sidebar-profile-trigger-avatar"/);
    expect(html).toMatch(/class="globalProfileName"/);
  });

  test("Home does not hide the sidebar before DOMContentLoaded", () => {
    const html = read("frontend/dashboard-paralegal.html");
    expect(html).not.toMatch(/body:not\(\.sidebar-layout-ready\) #sidebarNav/);
    expect(html).not.toMatch(/classList\.add\("sidebar-layout-ready"\)/);
  });

  test("Account Settings exposes its shell immediately and scopes loading to content", () => {
    const html = read("frontend/profile-settings.html");
    expect(html).not.toMatch(/id="accountSettingsBoot"/);
    expect(html).not.toMatch(/body:not\(\.settings-layout-ready\) > :not/);
    expect(html).toMatch(/id="settingsContent" aria-busy="true"/);
    expect(html).toMatch(/sidebar-layout-ready settings-layout-ready/);

    const script = read("frontend/assets/scripts/profile-settings.js");
    expect(script).toMatch(/getElementById\("settingsContent"\)\?\.removeAttribute\("aria-busy"\)/);
  });

  test("shared CSS reserves sidebar navigation and delayed Assistant geometry", () => {
    const product = read("frontend/assets/styles/product-clean.css");
    const header = read("frontend/assets/styles/universal-header.css");
    expect(product).toMatch(/:not\(\.lpc-sidebar-nav-link\)::before/);
    expect(product).toMatch(/flex:\s*0 0 18px/);
    expect(header).toMatch(/lpc-universal-header-controls:not\(:has\(> \.support-launcher\)\)::after/);
    expect(header).toMatch(/flex:\s*0 0 46px/);
  });

  test("shared scripts adopt the initial shell instead of requiring a reconstructed one", () => {
    const sidebar = read("frontend/assets/scripts/sidebar-profile.js");
    const header = read("frontend/assets/scripts/universal-header.js");
    expect(sidebar).toMatch(/#sidebarNav \[data-lpc-sidebar-profile-trigger\]/);
    expect(sidebar).toMatch(/host\.contains\(cluster\)/);
    expect(header).toMatch(/data-lpc-universal-header='true'/);
    expect(header).toMatch(/sharedHeaderHost/);
  });
});
