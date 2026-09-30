const { normalizeHttpUrl } = require("../utils/httpUrl");

describe("public HTTP URL policy", () => {
  test("normalizes HTTP URLs and enforces a required host", () => {
    expect(
      normalizeHttpUrl("https://www.linkedin.com/in/example", {
        fieldLabel: "LinkedIn URL",
        requiredHost: "linkedin.com",
      })
    ).toEqual({ ok: true, value: "https://www.linkedin.com/in/example" });
    expect(
      normalizeHttpUrl("https://example.com/in/example", { requiredHost: "linkedin.com" }).ok
    ).toBe(false);
  });

  test("rejects executable schemes and credential-bearing URLs", () => {
    expect(normalizeHttpUrl("javascript:alert(1)").ok).toBe(false);
    expect(normalizeHttpUrl("data:text/html,unsafe").ok).toBe(false);
    expect(normalizeHttpUrl("https://user:secret@example.com/").ok).toBe(false);
  });

  test("accepts an empty optional value", () => {
    expect(normalizeHttpUrl(null)).toEqual({ ok: true, value: "" });
  });
});
