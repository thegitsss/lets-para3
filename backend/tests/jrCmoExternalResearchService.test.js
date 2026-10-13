jest.mock("axios", () => ({
  get: jest.fn(),
}));

const axios = require("axios");
const {
  buildExternalDayResearch,
  parseGoogleNewsRss,
} = require("../services/marketing/jrCmoExternalResearchService");

describe("Jr. CMO external research service", () => {
  const envBackup = {
    enabled: process.env.MARKETING_JR_CMO_EXTERNAL_RESEARCH_ENABLED,
    queries: process.env.MARKETING_JR_CMO_EXTERNAL_RESEARCH_QUERIES,
  };

  beforeEach(() => {
    axios.get.mockReset();
    delete process.env.MARKETING_JR_CMO_EXTERNAL_RESEARCH_QUERIES;
  });

  afterAll(() => {
    if (envBackup.enabled === undefined) {
      delete process.env.MARKETING_JR_CMO_EXTERNAL_RESEARCH_ENABLED;
    } else {
      process.env.MARKETING_JR_CMO_EXTERNAL_RESEARCH_ENABLED = envBackup.enabled;
    }
    if (envBackup.queries === undefined) {
      delete process.env.MARKETING_JR_CMO_EXTERNAL_RESEARCH_QUERIES;
    } else {
      process.env.MARKETING_JR_CMO_EXTERNAL_RESEARCH_QUERIES = envBackup.queries;
    }
  });

  test("returns a disabled result when external research is off", async () => {
    process.env.MARKETING_JR_CMO_EXTERNAL_RESEARCH_ENABLED = "false";

    const result = await buildExternalDayResearch();

    expect(result).toEqual(
      expect.objectContaining({
        ok: false,
        reason: "disabled",
        sourceMode: "internal_only",
      })
    );
    expect(axios.get).not.toHaveBeenCalled();
  });

  test("parses RSS results into structured source items", () => {
    const items = parseGoogleNewsRss(
      `<?xml version="1.0" encoding="UTF-8"?>
      <rss><channel>
        <item>
          <title>Law firms tighten hiring amid budget pressure - Example Source</title>
          <link>https://example.com/article-1</link>
          <pubDate>Tue, 24 Mar 2026 10:00:00 GMT</pubDate>
          <source url="https://example.com">Example Source</source>
        </item>
      </channel></rss>`,
      "legal industry"
    );

    expect(items).toEqual([
      expect.objectContaining({
        title: "Law firms tighten hiring amid budget pressure",
        link: "https://example.com/article-1",
        sourceName: "Example Source",
        query: "legal industry",
      }),
    ]);
  });

  test("builds a cautious external day context from risk-leaning headlines", async () => {
    process.env.MARKETING_JR_CMO_EXTERNAL_RESEARCH_ENABLED = "true";
    process.env.MARKETING_JR_CMO_EXTERNAL_RESEARCH_QUERIES = "legal industry";

    axios.get.mockResolvedValue({
      data: `<?xml version="1.0" encoding="UTF-8"?>
      <rss><channel>
        <item>
          <title>Law firms face compliance scrutiny as budgets tighten - Example Source</title>
          <link>https://example.com/article-1</link>
          <pubDate>Tue, 24 Mar 2026 10:00:00 GMT</pubDate>
          <source url="https://example.com">Example Source</source>
        </item>
        <item>
          <title>Legal teams slow hiring amid risk pressure - Another Source</title>
          <link>https://example.com/article-2</link>
          <pubDate>Tue, 24 Mar 2026 12:00:00 GMT</pubDate>
          <source url="https://example.com">Another Source</source>
        </item>
      </channel></rss>`,
    });

    const result = await buildExternalDayResearch({ now: new Date("2026-03-24T14:00:00Z") });

    expect(result).toEqual(
      expect.objectContaining({
        ok: true,
        sourceMode: "external_research",
        toneRecommendation: "cautious",
      })
    );
    expect(result.industryClimateSummary).toMatch(/March 24, 2026/);
    expect(result.activeSignals).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/compliance scrutiny/i),
        expect.stringMatching(/slow hiring/i),
      ])
    );
    expect(result.sourceRefs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          url: "https://example.com/article-1",
        }),
      ])
    );
  });
});
