const User = require("../models/User");
const {
  APPLY_CONFIRMATION,
  buildAccountThemeUpdate,
  readExpectedCount,
  transitionFilter,
} = require("../scripts/migrate-account-themes");

describe("current account appearance transition", () => {
  test.each([{ stripeChargesEnabled: 1 }, { stripeChargesEnabled: 1, "preferences.fontSize": 1 }])("a partial user save does not write an unread theme: %j", async projection => {
    const user = User.hydrate({ _id: "650000000000000000000001", stripeChargesEnabled: false, ...(projection["preferences.fontSize"] ? { preferences: { fontSize: "lg" } } : {}) }, projection);
    user.stripeChargesEnabled = true;
    await user.validate();
    expect(user.$getChanges()).toEqual({ $set: { stripeChargesEnabled: true } });
  });

  test("an explicitly changed theme on a partial user still normalizes", async () => {
    const user = User.hydrate({ _id: "650000000000000000000001", stripeChargesEnabled: false }, { stripeChargesEnabled: 1 });
    user.set("preferences.theme", "retired-dashboard-dark");
    await user.validate();
    expect(user.$getChanges()).toEqual({ $set: { "preferences.theme": "dark" } });
  });

  test("Light, Dark and System are valid account appearances", () => {
    const themePath = User.schema.path("preferences.theme");
    expect(themePath.enumValues).toEqual(["light", "dark", "system"]);
  });

  test("retired appearance values normalize without changing other user information", async () => {
    const user = new User({
      firstName: "Preserved",
      lastName: "Member",
      email: "preserved.member@example.com",
      password: "Password123!",
      role: "paralegal",
      status: "approved",
      state: "VA",
      skills: ["Legal research"],
      preferences: {
        theme: "retired-dashboard-dark",
        fontSize: "lg",
        hideProfile: true,
      },
    });

    await user.validate();

    expect(user.preferences.theme).toBe("dark");
    expect(user.preferences.fontSize).toBe("lg");
    expect(user.preferences.hideProfile).toBe(true);
    expect(user.firstName).toBe("Preserved");
    expect(user.lastName).toBe("Member");
    expect(user.email).toBe("preserved.member@example.com");
    expect(user.state).toBe("VA");
    expect(user.skills).toEqual(["Legal research"]);
  });

  test("the migration changes only the account theme field and is idempotent", () => {
    expect(buildAccountThemeUpdate("retired-dashboard")).toEqual({ "preferences.theme": "light" });
    expect(buildAccountThemeUpdate("retired-dashboard-dark")).toEqual({ "preferences.theme": "dark" });
    expect(buildAccountThemeUpdate("light")).toBeNull();
    expect(buildAccountThemeUpdate("dark")).toBeNull();
    expect(buildAccountThemeUpdate("system")).toBeNull();
    expect(transitionFilter()).toEqual({
      $and: [
        { "preferences.theme": { $type: "string" } },
        { "preferences.theme": { $nin: ["light", "dark", "system"] } },
      ],
    });
  });

  test("apply mode has an exact confirmation phrase and expected-count parser", () => {
    expect(APPLY_CONFIRMATION).toBe("TRANSITION ACCOUNT THEMES TO CURRENT DASHBOARD");
    expect(readExpectedCount(["node", "script", "--expected-count=42"])).toBe(42);
    expect(readExpectedCount(["node", "script", "--expected-count=-1"])).toBeNull();
    expect(readExpectedCount(["node", "script"])).toBeNull();
  });
});
