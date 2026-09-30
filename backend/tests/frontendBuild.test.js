const fs = require("fs"), path = require("path"), vm = require("vm");
const { execFile } = require("child_process"), { promisify } = require("util"), { pathToFileURL } = require("url");
const { PROJECT_ROOT, RECIPE_INPUTS, frontendDirectory } = require("../utils/frontendAssets");
const runNode = async code => {
  const result = await promisify(execFile)(process.execPath, ["-e", code], { env: { PATH: process.env.PATH, NODE_ENV: "test" }, timeout: 30000, maxBuffer: 2 * 1024 * 1024 });
  return JSON.parse(result.stdout);
};
// Babel 8 is ESM. Use the actual Node 24 module loader and build process,
// rather than Jest's separate dependency transformer.
async function buildFrontend(projectRoot, changeDuringWrite = false) {
  return runNode(`
    const fs = require("fs"), path = require("path"), root = ${JSON.stringify(projectRoot)};
    const {buildFrontend} = require(${JSON.stringify(path.join(PROJECT_ROOT, "backend/scripts/build-frontend.js"))});
    if (${changeDuringWrite}) {
      const originalWrite = fs.writeFileSync; let changed = false;
      fs.writeFileSync = (file, ...args) => {
        const result = originalWrite(file, ...args);
        if (!changed && String(file).includes(".lpc-build-") && String(file).endsWith("/frontend/index.html")) {
          changed = true; originalWrite(path.join(root, "frontend/index.html"), "Changed during generation");
        }
        return result;
      };
    }
    buildFrontend(root).then(value => console.log(JSON.stringify(value))).catch(error => { console.error(error.message); process.exitCode = 1; });
  `);
}
let root;
const write = (file, value) => { const target = path.join(root, file); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, value); };
const read = file => fs.readFileSync(path.join(root, file), "utf8");
beforeEach(() => {
  root = fs.mkdtempSync("/private/tmp/lpc-frontend-build-test-");
  for (const file of RECIPE_INPUTS) write(file, "Synthetic recipe input");
  write("backend/package.json", JSON.stringify({ devDependencies: { terser: require("terser/package.json").version, "clean-css": require("clean-css/package.json").version } }));
  write("frontend/index.html", '<!doctype html><main>Build fixture</main><script src="/assets/scripts/classic.js"></script>');
  write("frontend/assets/styles/main.css", ".example { color: black; }");
  write("frontend/assets/example.bin", Buffer.from([0, 1, 255, 10]));
  write("frontend/assets/scripts/classic.js", 'function namedTask(value) { return value?.title ?? "empty"; }\nclass NamedMatter {}\nglobalThis.result = [namedTask.name, NamedMatter.name, namedTask({title:"Matter"}), String.raw`line\\n${2}\\end`];\n');
  write("frontend/assets/scripts/module.mjs", 'await Promise.resolve();\nexport function namedAction() { return "ready"; }\nexport const result = [namedAction.name, namedAction()];\n');
});
afterEach(() => { jest.restoreAllMocks(); fs.rmSync(root, { recursive: true, force: true }); });

test("the current complete frontend preserves semantic syntax in every emitted script", async () => {
  const result = await runNode(`
    const fs = require("fs"), path = require("path"), root = ${JSON.stringify(PROJECT_ROOT)};
    const {buildFrontend} = require(path.join(root,"backend/scripts/build-frontend.js"));
    const syntax = require(path.join(root,"backend/tests/helpers/frontendSemanticSyntax.js"));
    buildFrontend(root).then(manifest => {
      const scripts = manifest.files.filter(file => file.path.startsWith("assets/scripts/") && /\\.(mjs|js)$/.test(file.path));
      const differences = scripts.filter(file => JSON.stringify(syntax(fs.readFileSync(path.join(root,"frontend",file.path),"utf8"))) !== JSON.stringify(syntax(fs.readFileSync(path.join(root,".lpc-build/frontend",file.path),"utf8")))).map(file=>file.path);
      console.log(JSON.stringify({scripts:scripts.length,differences}));
    }).catch(error => { console.error(error.message); process.exitCode = 1; });
  `);
  expect(result.scripts).toBeGreaterThan(0); expect(result.differences).toEqual([]);
});

test("build output is deterministic, executes classic and async-module code, and preserves other assets", async () => {
  const first = await buildFrontend(root);
  expect(await buildFrontend(root)).toEqual(first);
  expect(frontendDirectory({ projectRoot: root, built: true })).toBe(path.join(root, ".lpc-build/frontend"));
  expect(frontendDirectory({ projectRoot: root, built: false })).toBe(path.join(root, "frontend"));
  for (const file of ["index.html", "assets/example.bin"]) expect(fs.readFileSync(path.join(root, ".lpc-build/frontend", file))).toEqual(fs.readFileSync(path.join(root, "frontend", file)));
  expect(read(".lpc-build/frontend/assets/styles/main.css")).toBe(".example{color:black}\n");
  const before = {}, after = {};
  vm.runInNewContext(read("frontend/assets/scripts/classic.js"), before);
  vm.runInNewContext(read(".lpc-build/frontend/assets/scripts/classic.js"), after);
  expect(after.result).toEqual(before.result);
  const env = { PATH: process.env.PATH, NODE_ENV: "test" };
  const modulePath = pathToFileURL(path.join(root, ".lpc-build/frontend/assets/scripts/module.mjs")).href;
  const run = await promisify(execFile)(process.execPath, ["--input-type=module", "-e", `const value = await import(${JSON.stringify(modulePath)}); console.log(JSON.stringify(value.result));`], { env, timeout: 10000 });
  expect(JSON.parse(run.stdout)).toEqual(["namedAction", "ready"]);
});

test.each([
  ["changed source", () => write("frontend/index.html", "Changed source")],
  ["added source", () => write("frontend/new.html", "Added source")],
  ["removed source", () => fs.unlinkSync(path.join(root, "frontend/index.html"))],
  ["changed output", () => write(".lpc-build/frontend/index.html", "Damaged output")],
  ["extra output", () => write(".lpc-build/frontend/extra.html", "Unexpected output")],
  ["changed recipe", () => write("backend/package-lock.json", "Changed dependency graph")],
  ["invalid manifest", () => write(".lpc-build/manifest.json", "invalid")],
])("startup rejects %s instead of silently serving it", async (_label, change) => {
  await buildFrontend(root); change();
  expect(() => frontendDirectory({ projectRoot: root, built: true })).toThrow(/Frontend build/);
});

test("a missing build cannot silently fall back to source", () => {
  expect(() => frontendDirectory({ projectRoot: root, built: true })).toThrow(/missing or unreadable/);
});

test("an unsuccessful parse leaves the previous generated build intact", async () => {
  await buildFrontend(root); const before = read(".lpc-build/manifest.json"), output = read(".lpc-build/frontend/index.html");
  write("frontend/assets/scripts/classic.js", "const broken = ;");
  await expect(buildFrontend(root)).rejects.toThrow();
  expect(read(".lpc-build/manifest.json")).toBe(before); expect(read(".lpc-build/frontend/index.html")).toBe(output);
  expect(fs.readdirSync(root).filter(file => file.startsWith(".lpc-build-"))).toEqual([]);
});

test("source changes during generation reject the candidate and preserve the previous build", async () => {
  await buildFrontend(root); const before = read(".lpc-build/manifest.json");
  await expect(buildFrontend(root, true)).rejects.toThrow(/source is out of date/);
  expect(read("frontend/index.html")).toBe("Changed during generation"); expect(read(".lpc-build/manifest.json")).toBe(before);
});

test("unowned output and symbolic links are rejected without replacing their files", async () => {
  write(".lpc-build/keep.txt", "Unrelated file");
  await expect(buildFrontend(root)).rejects.toThrow(/without an LPC build manifest/);
  expect(read(".lpc-build/keep.txt")).toBe("Unrelated file");
  fs.rmSync(path.join(root, ".lpc-build"), { recursive: true });
  fs.symlinkSync(path.join(root, "frontend/index.html"), path.join(root, "frontend/symbolic.html"));
  await expect(buildFrontend(root)).rejects.toThrow(/symbolic link/);
  expect(read("frontend/index.html")).toContain("Build fixture");
});

test("hidden source files are never read into the public build", async () => {
  write("frontend/.synthetic-private", "Synthetic private fixture");
  const manifest = await buildFrontend(root);
  expect(manifest.files.some(file => file.path.includes(".synthetic-private"))).toBe(false);
  expect(fs.existsSync(path.join(root, ".lpc-build/frontend/.synthetic-private"))).toBe(false);
});
