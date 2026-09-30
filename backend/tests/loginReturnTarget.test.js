const { resolve } = require("../../frontend/assets/scripts/utils/login-return-target");

describe("paralegal sign-in return boundary", () => {
  test.each([
    "/case-detail.html?caseId=64b000000000000000000991&tab=messages",
    "/dashboard-paralegal.html?applicationId=64b000000000000000000992#cases",
    "/profile-settings.html?tab=profile",
    "/paralegal-v2.html#/matter/64b000000000000000000991?tab=files",
  ])("preserves an authorized local destination: %s", path => expect(resolve(path, "paralegal")).toBe(path));
  test.each(["https://evil.example/case-detail.html", "//evil.example/case-detail.html", "/\\evil.example/case-detail.html", "javascript:alert(1)", "/admin-dashboard.html", "/dashboard-attorney.html", "/api/auth/logout", "/paralegal-v2.html#/unknown"]) (
    "rejects external or unauthorized destinations: %s", path => expect(resolve(path, "paralegal")).toBe("")
  );
  test.each(["attorney", "admin", "director", ""]) ("does not send role %s into paralegal work", role => expect(resolve("/dashboard-paralegal.html", role)).toBe(""));
});

describe('attorney sign-in return boundary', () => {
  test.each([
    '/attorney-v2.html#/matters/64b000000000000000000991/work?eventId=64b000000000000000000992',
    '/attorney-v2.html#/matters/64b000000000000000000991/deadlines?eventId=64b000000000000000000992',
    '/attorney-v2.html#/matters/new?caseDraftId=64b000000000000000000991',
    '/dashboard-attorney.html?workspace=legacy#cases:draft',
    '/create-case.html?draftId=64b000000000000000000991#review',
  ])('preserves an authorized local destination: %s', path => expect(resolve(path, 'attorney')).toBe(path));
  test.each(['/paralegal-v2.html#/home', '/admin-dashboard.html', '/attorney-v2.html#/unknown', 'https://evil.test/attorney-v2.html#/home', '/attorney-v2.html?unexpected=1#/home'])(
    'rejects an unauthorized return: %s', path => expect(resolve(path, 'attorney')).toBe('')
  );
});
