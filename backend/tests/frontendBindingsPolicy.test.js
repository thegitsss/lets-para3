const path = require("path");
const { spawnSync } = require("child_process");

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
});
