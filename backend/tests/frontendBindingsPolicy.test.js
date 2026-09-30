const path = require("path");
const { spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const { pathToFileURL } = require("url");

const checkerPath = path.resolve(__dirname, "../scripts/check-frontend-bindings.mjs");

function analyze(mode, source) {
  const result = spawnSync(process.execPath, [checkerPath, "--analyze", mode], {
    encoding: "utf8",
    input: source,
  });
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || `Analysis process exited ${result.status}`);
  }
  return JSON.parse(result.stdout);
}

describe("frontend binding policy", () => {
  test("rejects dead functions, state, locals, and imports", () => {
    const source = `
      import { secureFetch, unusedImport } from "./auth.js";
      const active = secureFetch;
      let abandonedState = null;
      function abandonedRenderer() {
        const abandonedLocal = "unused";
        abandonedState = active;
      }
    `;
    expect(analyze("unused", source)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "unusedImport" }),
        expect.objectContaining({ name: "abandonedRenderer" }),
        expect.objectContaining({ name: "abandonedLocal" }),
      ])
    );
  });

  test("accepts referenced, exported, and explicitly published browser APIs", () => {
    const source = `
      const internalValue = "ready";
      function initialize() { return internalValue; }
      window.initializeLpcSurface = initialize;
      export function publicFormatter(value) { return String(value); }
    `;
    expect(analyze("unused", source)).toEqual([]);
  });

  test("rejects unused parameters unless a positional contract is explicit", () => {
    const accidental = `function format(value) { return "fixed"; } format("unused");`;
    const positional = `function middleware(_request, response) { response.end(); } middleware(null, { end() {} });`;

    expect(analyze("parameters", accidental)).toEqual([
      expect.objectContaining({ name: "value", kind: "param" }),
    ]);
    expect(analyze("parameters", positional)).toEqual([]);
  });

  test("rejects awaited work swallowed by a comment-only catch", () => {
    const silent = `async function load() { try { await fetch("/api/data"); } catch { /* ignore */ } } load();`;
    const handled = `async function load() { try { await fetch("/api/data"); } catch (error) { console.warn(error); } } load();`;
    expect(analyze("catches", silent)).toEqual([expect.objectContaining({ line: 1 })]);
    expect(analyze("catches", handled)).toEqual([]);
  });

  test("finds missing local reads and writes without treating browser APIs as missing", () => {
    const source = `
      import { format } from "./format.mjs";
      export function render(amount) {
        const label = format(amount);
        document.body.textContent = label + money(amount);
        missingState = amount;
        ({ value: missingValue } = { value: amount });
        for (missingItem of [amount]) window.use(missingItem);
        window.optionalApi?.();
        return new HashChangeEvent("hashchange");
      }
    `;
    expect(analyze("unresolved", source).map(item => item.name)).toEqual(
      expect.arrayContaining(["money", "missingState", "missingValue", "missingItem"])
    );
    expect(analyze("unresolved", source).filter(item =>
      ["document", "window", "format", "amount", "HashChangeEvent"].includes(item.name))).toEqual([]);
  });

  test("permits feature detection only where the checked global is available", () => {
    const guarded = `
      if (typeof module === "object" && module.exports) module.exports = {};
      if (typeof optionalApi !== "undefined") optionalApi();
      typeof anotherApi === "function" && anotherApi();
    `;
    expect(analyze("unresolved", guarded)).toEqual([]);
    expect(analyze("unresolved", `${guarded}\nmodule.exports = {}; optionalApi();`)).toEqual([
      expect.objectContaining({ name: "module" }), expect.objectContaining({ name: "optionalApi" }),
    ]);
    expect(analyze("unresolved", `if (typeof optionalApi === "undefined") optionalApi();`)).toEqual([
      expect.objectContaining({ name: "optionalApi" }),
    ]);
  });

  test("does not hide dead locals inside exported functions or explicit rest omissions", () => {
    const source = `export function publicApi(record) {
      const unusedLocal = 1;
      const { owner: _owner, role: _role, ...safe } = record;
      return safe;
    }`;
    expect(analyze("unused", source)).toEqual([expect.objectContaining({ name: "unusedLocal" })]);
  });

  test("checks modules and executable HTML with exact lines and page-local classic bindings", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "lpc-binding-policy-"));
    try {
      fs.mkdirSync(path.join(root, "assets/scripts"), { recursive: true });
      fs.writeFileSync(path.join(root, "assets/scripts/view.mjs"), 'export const render = () => money(10);\n');
      fs.writeFileSync(path.join(root, "assets/scripts/shared.js"), 'function sharedFormat(value) { return String(value); }\n');
      fs.writeFileSync(path.join(root, "first.html"), [
        '<!-- <script>fakeComment();</script> -->',
        '<script type="application/ld+json">{"notJavaScript": true}</script>',
        '<script src="/assets/scripts/shared.js?v=1"></script>',
        '<script data-description="1 > 0">',
        'document.title = sharedFormat(10);',
        'function scoped() { const hidden = 1; return hidden; } scoped();',
        '</script>',
        '<script>',
        'document.title = hidden;',
        'missingInline();',
        '</script>',
        '<script type="module">const privateModule = 1; window.use(privateModule);</script>',
        '<script>window.use(privateModule);</script>',
      ].join('\n'));
      fs.writeFileSync(path.join(root, "second.html"), '<script>document.title = sharedFormat(20);</script>');
      const runner = `import { checkFrontendBindings } from ${JSON.stringify(pathToFileURL(checkerPath).href)}; console.log(JSON.stringify(checkFrontendBindings(process.argv[1])));`;
      const result = spawnSync(process.execPath, ["--input-type=module", "-e", runner, root], { encoding: "utf8" });
      if (result.status !== 0) throw new Error(result.stderr || result.stdout);
      const report = JSON.parse(result.stdout);
      expect(report.scriptFiles).toHaveLength(2);
      expect(report.htmlFiles).toHaveLength(2);
      expect(report.inlineScripts).toBe(5);
      expect(report.issues).toEqual(expect.arrayContaining([
        expect.objectContaining({ filePath: path.join(root, "assets/scripts/view.mjs"), message: "unresolved reference money" }),
        expect.objectContaining({ filePath: path.join(root, "first.html"), line: 9, message: "unresolved reference hidden" }),
        expect.objectContaining({ filePath: path.join(root, "first.html"), line: 10, message: "unresolved reference missingInline" }),
        expect.objectContaining({ filePath: path.join(root, "first.html"), line: 13, message: "unresolved reference privateModule" }),
        expect.objectContaining({ filePath: path.join(root, "second.html"), message: "unresolved reference sharedFormat" }),
      ]));
      expect(report.issues).toHaveLength(5);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
