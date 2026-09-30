const { run } = require("../scripts/repair-application-mirror");
const ids = ["--application=" + "1".repeat(24), "--matter=" + "2".repeat(24), "--owner=" + "3".repeat(24)];
const revision = "a".repeat(64);
let database, repairService;
beforeEach(() => {
  database = { connect: jest.fn(), disconnect: jest.fn() };
  repairService = { inspect: jest.fn().mockResolvedValue({ privateText: "Do not print this" }), summary: jest.fn().mockReturnValue({ needed: true, revision }), repair: jest.fn().mockResolvedValue({ changed: true, revision }) };
});
const execute = args => run(args, { database, repairService, mongoUri: "mongodb://127.0.0.1:27017/disposable" });

test("default inspection disables schema writes and emits only the bounded summary", async () => {
  expect(await execute(ids)).toEqual({ mode: "inspect", needed: true, revision });
  expect(database.connect).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ autoCreate: false, autoIndex: false }));
  expect(repairService.repair).not.toHaveBeenCalled();
  expect(database.disconnect).toHaveBeenCalledTimes(1);
});

test.each([
  [], [...ids, "--apply"], [...ids, "--apply", "--revision=" + revision],
  [...ids, "--revision=" + revision], [...ids, "--owner=" + "4".repeat(24)], [...ids, "--force"],
])("invalid or unreviewed repair cannot connect or mutate: %j", async (...args) => {
  await expect(execute(args)).rejects.toThrow();
  expect(database.connect).not.toHaveBeenCalled();
  expect(repairService.repair).not.toHaveBeenCalled();
});

test("an explicit repair carries the exact reviewed revision and selected identities", async () => {
  expect(await execute([...ids, "--apply", "--revision=" + revision, "--confirm=REPAIR_APPLICATION_MIRROR"])).toMatchObject({ mode: "apply", changed: true });
  expect(repairService.repair).toHaveBeenCalledWith({ applicationId: "1".repeat(24), caseId: "2".repeat(24), ownerId: "3".repeat(24) }, revision);
  expect(repairService.inspect).not.toHaveBeenCalled();
});

test("a refused repair remains a failure and releases the database connection", async () => {
  repairService.repair.mockRejectedValue(Object.assign(new Error("stale"), { code: "APPLICATION_REPAIR_UNSAFE" }));
  await expect(execute([...ids, "--apply", "--revision=" + revision, "--confirm=REPAIR_APPLICATION_MIRROR"])).rejects.toMatchObject({ code: "APPLICATION_REPAIR_UNSAFE" });
  expect(database.disconnect).toHaveBeenCalledTimes(1);
});

test("help never connects or inspects a record", async () => {
  expect(await execute(["--help"])).toContain("inspection is the default");
  expect(database.connect).not.toHaveBeenCalled();
  expect(repairService.inspect).not.toHaveBeenCalled();
});
