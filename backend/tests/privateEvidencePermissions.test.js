const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  inspectPrivateTree,
  securePrivateTree,
} = require("../scripts/private-evidence");

describe("private generated-evidence permissions", () => {
  let root;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "lpc-private-evidence-"));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  test("recursively restricts evidence directories and files to their owner", () => {
    const nested = path.join(root, "browser", "failure");
    fs.mkdirSync(nested, { recursive: true, mode: 0o755 });
    const screenshot = path.join(nested, "page.png");
    fs.writeFileSync(screenshot, "synthetic image", { mode: 0o644 });
    fs.chmodSync(root, 0o755);
    fs.chmodSync(nested, 0o755);
    fs.chmodSync(screenshot, 0o644);

    expect(inspectPrivateTree(root, "linux").length).toBeGreaterThan(0);
    expect(securePrivateTree(root, "linux")).toBe(true);
    expect(inspectPrivateTree(root, "linux")).toEqual([]);
    expect(fs.statSync(root).mode & 0o777).toBe(0o700);
    expect(fs.statSync(screenshot).mode & 0o777).toBe(0o600);
  });

  test("rejects symbolic links instead of following them", () => {
    if (process.platform === "win32") return;
    const outside = path.join(os.tmpdir(), `lpc-private-evidence-outside-${process.pid}`);
    fs.writeFileSync(outside, "outside", { mode: 0o600 });
    fs.symlinkSync(outside, path.join(root, "link"));
    try {
      expect(() => securePrivateTree(root, "linux")).toThrow(/symbolic links/);
      expect(fs.readFileSync(outside, "utf8")).toBe("outside");
    } finally {
      fs.rmSync(outside, { force: true });
    }
  });
});
