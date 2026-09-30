const { isEmailAddressShape } = require("../utils/emailAddressShape");

test("accepts ordinary addresses and rejects malformed or oversized input", () => {
  expect(isEmailAddressShape("person@example.com")).toBe(true);
  for (const value of ["", "person@", "@example.com", "person@example.", "person@example", "person@@example.com", "person name@example.com", "a@b." + ".".repeat(100000)]) {
    expect(isEmailAddressShape(value)).toBe(false);
  }
});
