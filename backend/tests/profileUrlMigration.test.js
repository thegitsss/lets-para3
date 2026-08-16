const { buildProfileUrlUpdate } = require("../scripts/migrate-profile-urls");

describe("profile URL migration", () => {
  test("clears unsafe historical URLs", () => {
    expect(
      buildProfileUrlUpdate({
        linkedInURL: "javascript:alert(1)",
        firmWebsite: "https://user:secret@example.com/",
      })
    ).toEqual({
      update: { linkedInURL: null, firmWebsite: "" },
      outcomes: ["invalid_linkedin_cleared", "invalid_firm_website_cleared"],
    });
  });

  test("clears non-LinkedIn hosts and canonicalizes valid values", () => {
    expect(
      buildProfileUrlUpdate({
        linkedInURL: "https://example.com/profile",
        firmWebsite: "https://example.com",
      })
    ).toEqual({
      update: { linkedInURL: null, firmWebsite: "https://example.com/" },
      outcomes: ["invalid_linkedin_cleared", "firm_website_canonicalized"],
    });
  });

  test("leaves canonical values unchanged", () => {
    expect(
      buildProfileUrlUpdate({
        linkedInURL: "https://www.linkedin.com/in/example",
        firmWebsite: "https://example.com/",
      })
    ).toEqual({ update: {}, outcomes: [] });
  });
});
