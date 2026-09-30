const fs = require("fs");
const path = require("path");

const read = (relativePath) => fs.readFileSync(path.join(__dirname, "../..", relativePath), "utf8");

describe("paralegal Phase 5 component modernization contract", () => {
  test("authenticated paralegal surfaces load the shared product component layer", () => {
    [
      "frontend/dashboard-paralegal.html",
      "frontend/browse-jobs.html",
      "frontend/case-detail.html",
      "frontend/profile-settings.html",
      "frontend/profile-paralegal.html",
    ].forEach((file) => {
      expect(read(file)).toContain("assets/styles/lpc-product-components.css");
    });
  });

  test("the shared layer owns the active state and legacy-dialog visual contracts", () => {
    const css = read("frontend/assets/styles/lpc-product-components.css");
    expect(css).toContain("Reusable loading, empty, error, badge, and pagination language");
    expect(css).toContain("Browse Matters: quiet filter rail and editorial result list");
    expect(css).toContain("My Matters & Applications: one aligned work register");
    expect(css).toContain("Matter workspace: stable white register");
    expect(css).toContain("Canonical legacy-dialog skin");
    expect(css).toMatch(/\.case-complete-modal[\s\S]*box-shadow:\s*none\s*!important/);
  });

  test("canonical utility dialogs use the LPC no-shadow treatment", () => {
    const css = read("frontend/assets/styles/dialogs.css");
    expect(css).toContain("border-radius: 3px");
    expect(css).toContain("box-shadow: none");
    expect(css).not.toContain("0 24px 64px");
  });

  test("paralegal settings do not load the attorney dashboard module", () => {
    const html = read("frontend/profile-settings.html");
    const loader = read("frontend/assets/scripts/profile-settings-role-loader.js");
    expect(html).not.toContain('src="assets/scripts/attorney-tabs.js"');
    expect(html).toContain('src="assets/scripts/profile-settings-role-loader.js');
    expect(loader).toContain('role === "attorney"');
    expect(loader).toContain('import("./attorney-tabs.js")');
  });

  test("Assistant CSS retains only the base, quiet skin, and active edge layout", () => {
    const css = read("frontend/assets/styles/support-drawer.css");
    expect(css).not.toContain("premium interface refresh");
    expect(css).toContain("Quiet-luxury assistant skin");
    expect(css).toContain("Edge-mounted Assistant drawer");
    expect(css.split("\n").length).toBeLessThan(1800);
  });

  test("paralegal Matter actions use the approved Details label", () => {
    const browse = read("frontend/assets/scripts/views/browse-jobs.js");
    const dashboard = read("frontend/assets/scripts/paralegal-dashboard.js");
    const dashboardHtml = read("frontend/dashboard-paralegal.html");
    expect(browse).toContain('caseBtn.textContent = "Details"');
    expect(dashboard).toContain(">Details</a>");
    expect(dashboardHtml).toContain('class="btn-link">Details</a>');
  });
});
