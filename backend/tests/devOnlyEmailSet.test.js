const { createDevOnlyEmailSet } = require("../utils/devOnlyEmailSet");

describe("development-only email switches", () => {
  test("production always receives an empty set", () => {
    const values = createDevOnlyEmailSet(
      ["developer@example.test"],
      { NODE_ENV: "production" }
    );

    expect(values.size).toBe(0);
    expect(values.has("developer@example.test")).toBe(false);
  });

  test.each(["development", "test", ""])(
    "non-production environment %p can opt into explicit fixture accounts",
    (NODE_ENV) => {
      const values = createDevOnlyEmailSet(
        ["developer@example.test"],
        { NODE_ENV }
      );

      expect(values).toEqual(new Set(["developer@example.test"]));
    }
  );
});
