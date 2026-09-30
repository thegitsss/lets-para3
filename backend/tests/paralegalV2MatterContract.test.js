const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "../..");
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");

describe("Paralegal V2 Matter workspace", () => {
  test("the Matter route uses existing authorized projections and preserves paralegal withdrawal and dispute mutations", () => {
    const app = read("frontend/assets/scripts/paralegal-v2/app.mjs");
    const view = read("frontend/assets/scripts/paralegal-v2/matter-view.mjs");
    expect(app).toMatch(/createMatterView/);
    expect(app).toMatch(/route\.name === "matter"/);
    expect(view).toMatch(/api\.get\(`\/api\/cases\/\$\{encodeURIComponent\(id\)\}\?\$\{new URLSearchParams\(\{ expectedOwnerId:/);
    expect(view).toMatch(/api\.get\(`\/api\/messages\/\$\{encodeURIComponent\(id\)\}`/);
    expect(view).toMatch(/matterExperience/);
    expect(view).toMatch(/api\.post\(`\/api\/cases\/\$\{encodeURIComponent\(matterId\)\}\/withdraw`/);
    expect(view).toMatch(/api\.post\(`\/api\/disputes\/\$\{encodeURIComponent\(matterId\)\}`/);
    const mutations = [...view.matchAll(/api\.(?:post|request)\(([^\n]+)/g)].map((match) => match[0]);
    expect(mutations).toHaveLength(2);
  });

  test("confidential views are server allowlisted and access failures disclose no Matter data", () => {
    const view = read("frontend/assets/scripts/paralegal-v2/matter-view.mjs");
    expect(view).toMatch(/experience\.sections\.some\(\(section\) => section\.id === "messages"\)/);
    expect(view).toMatch(/sectionIds\.has\(requested\)/);
    expect(view).toMatch(/You no longer have access to this matter/);
    expect(view).toMatch(/Matter not found/);
    expect(view).toMatch(/onAccessLost\?\.\(id\)/);
    expect(view).toMatch(/error\.status === 401[\s\S]*onSessionLost\?\.\(\)/);
    expect(view).not.toMatch(/localStorage|sessionStorage|innerHTML/);
  });

  test("active links enter V2 and completed history does not offer a broken workspace link", () => {
    const work = read("frontend/assets/scripts/paralegal-v2/work-view.mjs");
    expect(work).toMatch(/paralegal-v2\.html#\/matter\/\$\{encodeURIComponent\(id\)\}\?tab=overview/);
    expect(work).toMatch(/text: "Open workspace"/);
    expect(work).not.toMatch(/text: "View record"/);
    const activeRowStart = work.indexOf("function activeMatterRow");
    const activeRowEnd = work.indexOf("function activeSection", activeRowStart);
    expect(work.slice(activeRowStart, activeRowEnd)).not.toMatch(/case-detail\.html/);
  });

  test("the workspace is included in the V2 shell and uses its own scoped stylesheet", () => {
    const html = read("frontend/paralegal-v2.html");
    const css = read("frontend/assets/styles/paralegal-v2-matter.css");
    expect(html).toMatch(/paralegal-v2-matter\.css/);
    expect(css).toMatch(/\.v2-matter\s*\{/);
    expect(css).toMatch(/container:\s*v2-matter \/ inline-size/);
    expect(css).toMatch(/@container v2-matter/);
    expect(css).not.toMatch(/box-shadow/);
  });
});
