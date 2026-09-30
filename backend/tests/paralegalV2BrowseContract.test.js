const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "../..");
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");

describe("Paralegal V2 Browse Matters contract", () => {
  test("Browse is a real same-document view inside the persistent shell", () => {
    const html = read("frontend/paralegal-v2.html");
    const app = read("frontend/assets/scripts/paralegal-v2/app.mjs");
    expect(html).toMatch(/paralegal-v2-browse\.css/);
    expect(app).toMatch(/createBrowseView/);
    expect(app).toMatch(/route\.name === "browse"/);
    expect(app).toMatch(/browseView\.render/);
    expect(app).not.toMatch(/location\.(?:assign|replace)\([^)]*browse-jobs/);
  });

  test("Browse consumes authoritative listing and application projections", () => {
    const source = read("frontend/assets/scripts/paralegal-v2/browse-view.mjs");
    expect(source).toContain('view: "browse"');
    expect(source).toContain('`/api/jobs/open?${params}`');
    expect(source).toContain('api.get(key).then(readBrowsePage)');
    expect(source).toContain('snapshot.facets');
    expect(source).toContain('snapshot.totalPages');
    expect(source).toContain('snapshot.selected');
    expect(source).not.toMatch(/api\.get\("\/api\/(?:applications\/my|users\/me)"\)/);
    expect(source).not.toMatch(/function\s+(?:filterListings|visibleListings|appliedJobIds)/);
    expect(source).toMatch(/matter\.applicationEligibility/);
    expect(source).not.toMatch(/minimumYearsExperience\s*>\s*(?:profile|years)/);
    expect(source).not.toMatch(/function\s+(?:matchesRecommendation|recommendationEligible)/);
  });

  test("Browse preserves current filters, sorting, history, deep links, and approved language", () => {
    const source = read("frontend/assets/scripts/paralegal-v2/browse-view.mjs");
    [
      "Practice area",
      "State",
      "Minimum matter amount",
      "Deadline",
      "Date posted",
      "Newest",
      "Soonest due",
      "Highest pay",
      "Lowest pay",
      "Details",
      "Report this matter",
    ].forEach((copy) => expect(source).toContain(copy));
    expect(source).toMatch(/route\.query\.get\("matterId"\)/);
    expect(source).toMatch(/writeFiltersToHash/);
    expect(source).toMatch(/navigateFilters/);
    expect(source).toMatch(/publishRecommendationHistoryChange/);
  });

  test("applications and flags use the existing protected mutation endpoints", () => {
    const source = read("frontend/assets/scripts/paralegal-v2/browse-view.mjs");
    expect(source).toMatch(/`\/api\/jobs\/\$\{encodeURIComponent\(target\.id\)\}\/apply`/);
    expect(source).toMatch(/`\/api\/cases\/\$\{encodeURIComponent\(target\.id\)\}\/apply`/);
    expect(source).toMatch(/api\.post\(`\/api\/cases\/\$\{encodeURIComponent\(matterId\(matter\)\)\}\/flag`/);
    expect(source).toMatch(/note\.length < 20/);
    expect(source).toMatch(/maxlength: APPLY_MAX_CHARACTERS/);
    expect(source).not.toMatch(/fetch\(/);
    expect(source).not.toMatch(/location\.reload/);
  });

  test("keeps unfinished application copy in memory and clears it only after server-confirmed submission", () => {
    const source = read("frontend/assets/scripts/paralegal-v2/browse-view.mjs");
    expect(source).toContain("const applicationDrafts = new Map()");
    expect(source).toMatch(/drafts\.set\(draftKey, textarea\.value\)/);
    expect(source).toMatch(/await api\.post\(path, \{ coverLetter: note \}\);[\s\S]*drafts\.delete\(draftKey\)/);
  });

  test("Browse styling is isolated, responsive, white-canvas, and shadow-free", () => {
    const css = read("frontend/assets/styles/paralegal-v2-browse.css");
    expect(css).toMatch(/^\.v2-browse \{/m);
    expect(css).toMatch(/grid-template-columns: minmax\(0, 1fr\)/);
    expect(css).toMatch(/@media \(max-width: 760px\)/);
    expect(css).toMatch(/@media \(max-width: 520px\)/);
    expect(css).toMatch(/background: var\(--v2-white\)/);
    expect(css).not.toMatch(/box-shadow/);
  });
});
