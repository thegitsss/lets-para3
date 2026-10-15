const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "../..");
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");

describe("Prompt 4 productivity filter contracts", () => {
  test("attorney Matters expose compact labelled filters, reset, sorting, and URL state", () => {
    const html = read("frontend/dashboard-attorney.html");
    const script = read("frontend/assets/scripts/attorney-tabs.js");
    const api = read("frontend/assets/scripts/attorney-v2/api-client.mjs");
    const inventory = read("backend/services/attorneyMatterInventory.js");
    expect(html).toMatch(/data-matter-filter-menu/);
    expect(html).toMatch(/data-matter-practice-filter/);
    expect(html).toMatch(/data-matter-deadline-filter/);
    expect(html).toMatch(/data-matter-updated-filter/);
    expect(html).toMatch(/data-matter-sort/);
    expect(html).toMatch(/data-matter-filter-reset/);
    expect(script).toContain('caseNoteApi.readMatterInventory(filters, options)');
    expect(script).toContain('currentMatterInventory.load(currentMatterFilters(), options)');
    expect(api).toContain("['view', 'practice', 'deadline', 'updated', 'sort', 'archiveStatus', 'page', 'targetId']");
    expect(api).toContain('workspaceRead(`/api/cases/inventory?${query}`, options)');
    expect(script).toMatch(/matterPractice.*matterDeadline.*matterUpdated.*matterSort/s);
    const searchProjection = inventory.match(/__inventorySearch: \{[^\n]+/)?.[0];
    expect(searchProjection).toBeTruthy();
    expect(searchProjection).toMatch(/\$title.*\$practiceArea.*\$__inventoryParalegal\.firstName.*\$__inventoryParalegal\.lastName/);
    expect(searchProjection).not.toMatch(/internalNotes|details/);
  });

  test("paralegal Applications include the previously missing status control and useful sort modes", () => {
    const html = read("frontend/dashboard-paralegal.html");
    const script = read("frontend/assets/scripts/paralegal-dashboard.js");
    expect(html).toMatch(/id="appliedStatusFilter"/);
    expect(html).toMatch(/id="appliedSort"/);
    expect(html).toMatch(/value="newest"/);
    expect(html).toMatch(/value="oldest"/);
    expect(html).toMatch(/value="matter"/);
    expect(script).toMatch(/status\.addEventListener\('change'/);
    expect(script).toMatch(/sort\?\.addEventListener\('change'/);
    expect(script).toMatch(/sortMode === 'matter'/);
  });

  test("Browse Matters uses real deadline/date fields and removes the unsupported experience filter", () => {
    const html = read("frontend/browse-jobs.html");
    const script = read("frontend/assets/scripts/views/browse-jobs.js");
    const route = read("backend/services/openMatterDiscovery.js");
    expect(html).toMatch(/id="filterDeadline"/);
    expect(html).toMatch(/id="filterPosted"/);
    expect(html).toMatch(/value="deadline"/);
    expect(html).not.toMatch(/id="filterMinExp"|Experience Required/);
    expect(script).toMatch(/function discoveryRequestPath/);
    expect(script).toContain('view: "browse"');
    expect(script).toContain('page.total');
    expect(script).toContain('page.facets');
    expect(script).not.toContain('filteredJobs.slice(');
    expect(script).toMatch(/function syncBrowseFilterUrl/);
    expect(script).toMatch(/browsePractice.*browseState.*browseMinPay.*browseDeadline.*browsePosted.*browseSort/s);
    expect(script).not.toMatch(/function getJobExperience/);
    expect(route).toMatch(/deadlineDate: resolveMatterDeadlineDate\(caseDoc\)/);
    expect(route).toMatch(/deadline: resolveMatterDeadlineDate\(caseDoc\) \|\| null/);
    expect(route).toMatch(/createdAt deadline deadlineDate tasks/);
  });
});
