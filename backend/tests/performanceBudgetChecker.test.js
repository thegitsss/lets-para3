const { isCanonicalRedirect } = require("../scripts/check-performance-budgets");

describe("performance budget redirect classification", () => {
  test("recognizes only the explicit canonical redirect contract", () => {
    expect(
      isCanonicalRedirect(`
        <body data-redirect-target="dashboard-attorney.html#cases" data-preserve-search="true">
          <script defer src="assets/scripts/canonical-redirect.js"></script>
        </body>
      `)
    ).toBe(true);
    expect(
      isCanonicalRedirect(`
        <body data-redirect-target="dashboard-attorney.html#cases"></body>
      `)
    ).toBe(false);
    expect(
      isCanonicalRedirect(`
        <body><script defer src="assets/scripts/canonical-redirect.js"></script></body>
      `)
    ).toBe(false);
  });
});
