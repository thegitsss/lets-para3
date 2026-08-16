const fs = require("fs");
const path = require("path");
const {
  CANONICAL_PUBLIC_DOCUMENT_PATHS,
  INDEXABLE_HTML_DOCUMENTS,
} = require("../utils/staticCache");

const repositoryRoot = path.resolve(__dirname, "../..");
const frontendRoot = path.join(repositoryRoot, "frontend");

describe("public indexing policy", () => {
  test("the sitemap is exactly the explicit indexable-document allowlist", () => {
    const sitemap = fs.readFileSync(path.join(repositoryRoot, "public/sitemap.xml"), "utf8");
    const absoluteLocations = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => match[1]);
    expect(new Set(absoluteLocations).size).toBe(absoluteLocations.length);
    for (const location of absoluteLocations) {
      const url = new URL(location);
      expect(url.origin).toBe("https://www.lets-paraconnect.com");
      expect(url.search).toBe("");
      expect(url.hash).toBe("");
    }
    const locations = [...sitemap.matchAll(/<loc>https:\/\/www\.lets-paraconnect\.com\/([^<]*)<\/loc>/g)]
      .map((match) => match[1] || "index.html")
      .sort();
    expect(locations).toEqual([...INDEXABLE_HTML_DOCUMENTS].sort());
    expect(sitemap).not.toMatch(/<(?:priority|changefreq)>/i);
    expect(Object.values(CANONICAL_PUBLIC_DOCUMENT_PATHS).sort()).toEqual(
      locations.map((document) => document === "index.html" ? "/" : `/${document}`).sort()
    );
  });

  test("indexable marketing documents have useful search-result metadata", () => {
    for (const document of INDEXABLE_HTML_DOCUMENTS) {
      const html = fs.readFileSync(path.join(frontendRoot, document), "utf8");
      expect(html).toMatch(/<title>[^<]{10,}<\/title>/i);
      if (!["privacy.html", "terms.html"].includes(document)) {
        expect(html).toMatch(/<meta\s+name=["']description["']\s+content=["'][^"']{50,}["']\s*\/?\s*>/i);
      }
    }
  });

  test("every non-indexable page exists and new pages default to noindex at delivery", () => {
    const allDocuments = fs.readdirSync(frontendRoot)
      .filter((name) => name.endsWith(".html"))
      .sort();
    const nonIndexable = allDocuments.filter((name) => !INDEXABLE_HTML_DOCUMENTS.includes(name));
    expect(nonIndexable).toContain("login.html");
    expect(nonIndexable).toContain("dashboard-attorney.html");
    expect(nonIndexable).toContain("404.html");
    expect(nonIndexable.length).toBeGreaterThan(20);
  });

  test("robots excludes API representations while allowing document-level noindex headers to be read", () => {
    const robots = fs.readFileSync(path.join(repositoryRoot, "public/robots.txt"), "utf8");
    expect(robots).toMatch(/^User-agent: \*$/m);
    expect(robots).toMatch(/^Disallow: \/api\/$/m);
    expect(robots).toMatch(/^Disallow: \/public\/$/m);
    for (const document of INDEXABLE_HTML_DOCUMENTS) {
      expect(robots).not.toContain(`Disallow: /${document}`);
    }
  });
});
