const { createMatterCalendar } = require("./matterCalendar");

// Preserve the existing attorney receipt namespace and access policy.
module.exports = createMatterCalendar({
  access: require("./attorneyMatterFiles"),
  role: "attorney",
  kind: "attorney_calendar_action",
});
