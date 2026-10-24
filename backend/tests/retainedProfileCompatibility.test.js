const User = require("../models/User");

const retained = (overrides = {}) => User.hydrate({
  _id: "650000000000000000000001",
  firstName: "Existing", lastName: "Member", email: "existing@example.test",
  password: "Password123!", role: "paralegal", status: "approved",
  preferences: { theme: "retired-dashboard-dark", fontSize: "lg", hideProfile: true },
  linkedInURL: "linkedin.com/in/retained-member", firmWebsite: "retained.example.test",
  ...overrides,
});

test("an unrelated profile edit retains historical appearance and profile links", async () => {
  const user = retained();
  user.bio = "Updated professional experience.";
  await user.validate();
  expect(user.preferences.toObject ? user.preferences.toObject() : user.preferences).toMatchObject({
    theme: "retired-dashboard-dark", fontSize: "lg", hideProfile: true,
  });
  expect(user.linkedInURL).toBe("linkedin.com/in/retained-member");
  expect(user.firmWebsite).toBe("retained.example.test");
  const changes = user.$getChanges().$set || {};
  expect(changes.bio).toBe("Updated professional experience.");
  for (const field of ["preferences.theme", "linkedInURL", "firmWebsite"]) {
    expect(changes).not.toHaveProperty([field]);
  }
});

test("changing another preference retains the saved historical theme", async () => {
  const user = retained();
  user.set("preferences.fontSize", "xl");
  await user.validate();
  expect(user.preferences.theme).toBe("retired-dashboard-dark");
  const changes = user.$getChanges().$set || {};
  expect(changes["preferences.fontSize"]).toBe("xl");
  expect(changes).not.toHaveProperty(["preferences.theme"]);
});

test("replacing a preferences object does not normalize an unchanged historical theme", async () => {
  const user = retained();
  user.set("preferences", { ...user.toObject().preferences, hideProfile: false });
  await user.validate();
  expect(user.preferences.theme).toBe("retired-dashboard-dark");
  expect(user.preferences.hideProfile).toBe(false);
});

test("a deliberate theme change and valid profile links remain editable", async () => {
  const user = retained();
  user.set("preferences.theme", "light");
  user.linkedInURL = "https://www.linkedin.com/in/updated-member";
  user.firmWebsite = "https://updated.example.test/";
  await user.validate();
  expect(user.preferences.theme).toBe("light");
  expect(user.linkedInURL).toBe("https://www.linkedin.com/in/updated-member");
  expect(user.firmWebsite).toBe("https://updated.example.test/");
});

test.each(["linkedInURL", "firmWebsite"])("editing a retained %s to an unsafe value is rejected", async field => {
  const user = retained();
  user.set(field, "javascript:alert(1)");
  await expect(user.validate()).rejects.toMatchObject({ errors: { [field]: expect.anything() } });
});

test.each(["linkedInURL", "firmWebsite"])("new accounts cannot introduce an unsafe %s", async field => {
  const user = new User({
    firstName: "New", lastName: "Member", email: "new@example.test",
    password: "Password123!", role: "paralegal", [field]: "javascript:alert(1)",
  });
  await expect(user.validate()).rejects.toMatchObject({ errors: { [field]: expect.anything() } });
});

test("an existing-account marker alone cannot bypass new-value validation", async () => {
  const user = new User({
    firstName: "New", lastName: "Member", email: "marker@example.test",
    password: "Password123!", role: "paralegal", linkedInURL: "javascript:alert(1)",
  });
  user.isNew = false;
  await expect(user.validate()).rejects.toMatchObject({ errors: { linkedInURL: expect.anything() } });
});

test("the retained-value snapshot does not add stored or serialized account fields", async () => {
  const user = retained();
  await user.validate();
  const changes = user.$getChanges().$set || {};
  for (const field of ["preferences.theme", "linkedInURL", "firmWebsite", "retainedProfileValues"]) {
    expect(changes).not.toHaveProperty([field]);
  }
  expect(user.toObject()).not.toHaveProperty("retainedProfileValues");
  expect(user.toObject()).not.toHaveProperty("retainedProfileSnapshot");
});
