import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { parse } from "@babel/parser";
import traverse from "@babel/traverse";

const scriptPath = fileURLToPath(import.meta.url);
const scriptDirectory = path.dirname(scriptPath);
const repositoryRoot = path.resolve(scriptDirectory, "../..");
const frontendRoot = path.join(repositoryRoot, "frontend");

// Browser and ECMAScript globals only. Application APIs must be imported, declared
// in the same classic-script page, accessed through window, or feature-detected.
const browserGlobals = new Set(`
  Infinity NaN undefined globalThis Object Function Boolean Symbol Error AggregateError
  EvalError RangeError ReferenceError SyntaxError TypeError URIError Number BigInt Math
  Date String RegExp Array Int8Array Uint8Array Uint8ClampedArray Int16Array Uint16Array
  Int32Array Uint32Array Float32Array Float64Array BigInt64Array BigUint64Array Map Set
  WeakMap WeakSet WeakRef FinalizationRegistry ArrayBuffer SharedArrayBuffer Atomics
  DataView JSON Promise Reflect Proxy Intl WebAssembly isNaN isFinite parseFloat parseInt
  decodeURI decodeURIComponent encodeURI encodeURIComponent escape unescape eval
  console window self document navigator location history screen localStorage sessionStorage
  indexedDB caches performance crypto fetch Headers Request Response URL URLSearchParams
  FormData Blob File FileList FileReader Event CustomEvent EventTarget MouseEvent KeyboardEvent
  InputEvent PointerEvent TouchEvent FocusEvent SubmitEvent HashChangeEvent PopStateEvent WheelEvent
  HTMLElement HTMLInputElement HTMLTextAreaElement HTMLSelectElement HTMLButtonElement
  HTMLFormElement HTMLDialogElement Element Node NodeFilter Text DOMParser XMLSerializer
  DOMException MutationObserver ResizeObserver IntersectionObserver AbortController AbortSignal
  Image Audio AudioContext MediaRecorder MediaStream Worker WebSocket EventSource BroadcastChannel
  Notification ClipboardItem XMLHttpRequest XMLHttpRequestUpload requestAnimationFrame
  cancelAnimationFrame requestIdleCallback cancelIdleCallback setTimeout clearTimeout setInterval
  clearInterval queueMicrotask getComputedStyle matchMedia atob btoa structuredClone
  addEventListener removeEventListener dispatchEvent createImageBitmap
  alert confirm prompt print open close scroll scrollTo scrollBy innerWidth innerHeight
  scrollX scrollY devicePixelRatio CSS CSSStyleSheet CSSStyleDeclaration Option AudioBuffer
  OffscreenCanvas Path2D TextEncoder TextDecoder ReadableStream WritableStream TransformStream
  CompressionStream DecompressionStream IDBKeyRange DOMRect DOMMatrix visualViewport
`.trim().split(/\s+/));

function walk(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(directory, entry.name);
    return entry.isDirectory() ? walk(target) : [target];
  });
}

function isExportedBinding(bindingPath) {
  const declaration = bindingPath.isVariableDeclarator() ? bindingPath.parentPath : bindingPath;
  return Boolean(
    declaration.parentPath?.isExportNamedDeclaration() ||
    declaration.parentPath?.isExportDefaultDeclaration()
  );
}

function isExplicitRestOmission(name, binding) {
  if (!name.startsWith("_") || !binding.path.isVariableDeclarator()) return false;
  const pattern = binding.path.node.id;
  if (pattern.type !== "ObjectPattern") return false;
  return pattern.properties.some(property => property.type === "RestElement" &&
    property.argument.type === "Identifier" && property.argument.name !== name &&
    binding.scope.getBinding(property.argument.name)?.referenced);
}

function parseSource(source, filePath) {
  return parse(String(source), {
    sourceFilename: filePath,
    sourceType: "unambiguous",
  });
}

function findUnusedBindings(source, filePath = "frontend-script.js", externalReferences = new Set()) {
  const ast = parseSource(source, filePath);
  const unused = [];
  const seen = new Set();
  traverse(ast, {
    Scopable(scopePath) {
      for (const [name, binding] of Object.entries(scopePath.scope.bindings)) {
        const key = `${binding.identifier.start}:${name}`;
        if (seen.has(key)) continue;
        seen.add(key);
        if (
          binding.referenced ||
          binding.kind === "param" ||
          binding.path.isCatchClause() ||
          binding.path.isFunctionExpression() ||
          binding.path.isClassExpression() ||
          isExplicitRestOmission(name, binding) ||
          (binding.scope.path.isProgram() && externalReferences.has(name)) ||
          isExportedBinding(binding.path)
        ) {
          continue;
        }
        unused.push({
          name,
          line: binding.identifier.loc?.start?.line || 1,
          kind: binding.kind,
        });
      }
    },
  });
  return unused;
}

function findUnmarkedUnusedParameters(source, filePath = "frontend-script.js") {
  const ast = parseSource(source, filePath);
  const unused = [];
  const seen = new Set();
  traverse(ast, {
    Scopable(scopePath) {
      for (const [name, binding] of Object.entries(scopePath.scope.bindings)) {
        const key = `${binding.identifier.start}:${name}`;
        if (seen.has(key)) continue;
        seen.add(key);
        if (binding.kind !== "param" || binding.referenced || name.startsWith("_")) continue;
        unused.push({
          name,
          line: binding.identifier.loc?.start?.line || 1,
          kind: binding.kind,
        });
      }
    },
  });
  return unused;
}

function findSilentAwaitCatches(source, filePath = "frontend-script.js") {
  const ast = parseSource(source, filePath);
  const silent = [];
  traverse(ast, {
    CatchClause(catchPath) {
      if (catchPath.node.body.body.length) return;
      let containsAwait = false;
      catchPath.parentPath.get("block").traverse({
        Function(functionPath) {
          functionPath.skip();
        },
        AwaitExpression(awaitPath) {
          containsAwait = true;
          awaitPath.stop();
        },
      });
      if (containsAwait) silent.push({ line: catchPath.node.loc?.start?.line || 1 });
    },
  });
  return silent;
}

function conditionDefines(node, name) {
  if (!node) return false;
  if (node.type === "LogicalExpression" && node.operator === "&&") {
    return conditionDefines(node.left, name) || conditionDefines(node.right, name);
  }
  if (node.type !== "BinaryExpression") return false;
  const pairs = [[node.left, node.right], [node.right, node.left]];
  return pairs.some(([tested, value]) => {
    if (tested.type !== "UnaryExpression" || tested.operator !== "typeof" ||
        tested.argument.type !== "Identifier" || tested.argument.name !== name ||
        value.type !== "StringLiteral") return false;
    return (["!=", "!=="].includes(node.operator) && value.value === "undefined") ||
      (["==", "==="].includes(node.operator) &&
       ["object", "function", "string", "number", "boolean", "symbol", "bigint"].includes(value.value));
  });
}

function isFeatureDetected(referencePath, name) {
  if (referencePath.parentPath.isUnaryExpression({ operator: "typeof" })) return true;
  let child = referencePath;
  for (let parent = child.parentPath; parent; child = parent, parent = parent.parentPath) {
    if (parent.isFunction()) break; // A deferred callback can outlive the checked global.
    if ((parent.isIfStatement() || parent.isConditionalExpression()) && child.key === "consequent" &&
        conditionDefines(parent.node.test, name)) return true;
    if (parent.isLogicalExpression({ operator: "&&" }) && child.key === "right" &&
        conditionDefines(parent.node.left, name)) return true;
  }
  return false;
}

function findUnresolvedReferences(source, filePath = "frontend-script.js", externalBindings = new Set()) {
  const ast = parseSource(source, filePath);
  const unresolved = [];
  const seen = new Set();
  const check = (referencePath, identifier = referencePath.node) => {
    const { name } = identifier;
    if (browserGlobals.has(name) || externalBindings.has(name) || referencePath.scope.hasBinding(name) ||
        isFeatureDetected(referencePath, name)) return;
    const line = identifier.loc?.start?.line || 1;
    const key = `${line}:${name}`;
    if (seen.has(key)) return;
    seen.add(key);
    unresolved.push({ name, line });
  };
  traverse(ast, {
    ReferencedIdentifier(referencePath) { check(referencePath); },
    AssignmentExpression(assignmentPath) {
      const left = assignmentPath.get("left");
      for (const identifier of Object.values(left.getBindingIdentifiers())) check(left, identifier);
    },
    "ForInStatement|ForOfStatement"(loopPath) {
      const left = loopPath.get("left");
      if (!left.isVariableDeclaration()) {
        for (const identifier of Object.values(left.getBindingIdentifiers())) check(left, identifier);
      }
    },
  });
  return unresolved;
}

function htmlScripts(source, filePath) {
  const scripts = [];
  const tags = /<!--[\s\S]*?(?:-->|$)|<script\b((?:"[^"]*"|'[^']*'|[^'">])*)>([\s\S]*?)<\/script\s*>/gi;
  for (const match of String(source).matchAll(tags)) {
    if (match[1] === undefined) continue;
    const attributes = new Map();
    for (const attribute of match[1].matchAll(/([^\s=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s]+)))?/g)) {
      attributes.set(attribute[1].toLowerCase(), attribute[2] ?? attribute[3] ?? attribute[4] ?? "");
    }
    const type = (attributes.get("type") || "").trim().toLowerCase();
    if (type && type !== "module" && !/^(?:application|text)\/(?:java|ecma)script$/.test(type)) continue;
    const contentStart = match.index + "<script".length + match[1].length + 1;
    const lineOffset = source.slice(0, contentStart).split("\n").length - 1;
    scripts.push({
      filePath,
      source: "\n".repeat(lineOffset) + match[2],
      module: type === "module",
      src: attributes.get("src") ?? null,
      inline: true,
    });
  }
  return scripts;
}

function collectFrontendSources(root) {
  const scriptRoot = fs.existsSync(path.join(root, "assets", "scripts")) ? path.join(root, "assets", "scripts") : root;
  const scriptFiles = walk(scriptRoot).filter((filePath) => /\.(?:js|mjs)$/.test(filePath)).sort();
  const htmlFiles = walk(root).filter((filePath) => filePath.endsWith(".html")).sort();
  const units = scriptFiles.map((filePath) => ({ filePath, source: fs.readFileSync(filePath, "utf8"), module: filePath.endsWith(".mjs"), inline: false }));
  const byPath = new Map(units.map(unit => [unit.filePath, unit]));
  const pages = [];
  for (const filePath of htmlFiles) {
    const page = [];
    for (const script of htmlScripts(fs.readFileSync(filePath, "utf8"), filePath)) {
      if (script.src !== null) {
        if (/^(?:[a-z]+:|\/\/)/i.test(script.src)) continue;
        const sourcePath = script.src.split(/[?#]/, 1)[0];
        const resolved = sourcePath.startsWith("/") ? path.join(root, sourcePath.slice(1)) : path.resolve(path.dirname(filePath), sourcePath);
        const unit = byPath.get(resolved);
        if (unit && !script.module) page.push(unit);
      } else if (script.source.trim()) {
        units.push(script);
        if (!script.module) page.push(script);
      }
    }
    pages.push(page);
  }
  // Only top-level classic bindings can be shared, and only on every page that
  // loads that classic script. Function locals and module exports never leak.
  for (const unit of units) {
    try {
      const ast = parseSource(unit.source, unit.filePath);
      unit.module = unit.module || ast.program.sourceType === "module";
      unit.declarations = new Set();
      unit.free = new Set();
      traverse(ast, {
        Program(programPath) { unit.declarations = new Set(Object.keys(programPath.scope.bindings)); },
        ReferencedIdentifier(referencePath) {
          if (!referencePath.scope.hasBinding(referencePath.node.name)) unit.free.add(referencePath.node.name);
        },
      });
    } catch { /* The normal source check below reports the original parse location. */ }
  }
  for (const unit of units) {
    const contexts = unit.module ? [] : pages.filter(page => page.includes(unit));
    const bindings = contexts.map(page => new Set(page.filter(other => other !== unit && !other.module).flatMap(other => [...(other.declarations || [])])));
    unit.externalBindings = new Set((bindings[0] ? [...bindings[0]] : []).filter(name => bindings.every(context => context.has(name))));
    unit.externalReferences = new Set(contexts.flatMap(page => page.filter(other => other !== unit && !other.module).flatMap(other => [...(other.free || [])])));
  }
  return { units, scriptFiles, htmlFiles };
}

function checkFrontendBindings(root = frontendRoot) {
  const { units, scriptFiles, htmlFiles } = collectFrontendSources(root);
  const issues = [];
  for (const { filePath, source, externalBindings, externalReferences } of units) {
    let unused;
    let unmarkedUnusedParameters;
    let silentAwaitCatches;
    let unresolvedReferences;
    try {
      unused = findUnusedBindings(source, filePath, externalReferences);
      unmarkedUnusedParameters = findUnmarkedUnusedParameters(source, filePath);
      silentAwaitCatches = findSilentAwaitCatches(source, filePath);
      unresolvedReferences = findUnresolvedReferences(source, filePath, externalBindings);
    } catch (error) {
      issues.push({
        filePath,
        line: error?.loc?.line || 1,
        message: `could not parse: ${error.message}`,
      });
      continue;
    }
    for (const reference of unresolvedReferences) {
      issues.push({ filePath, line: reference.line, message: `unresolved reference ${reference.name}` });
    }
    for (const binding of unused) {
      issues.push({
        filePath,
        line: binding.line,
        message: `unused ${binding.kind} binding ${binding.name}`,
      });
    }
    for (const parameter of unmarkedUnusedParameters) {
      issues.push({
        filePath,
        line: parameter.line,
        message: `unused parameter ${parameter.name}; remove it or prefix it with _ when a positional contract requires it`,
      });
    }
    for (const caught of silentAwaitCatches) {
      issues.push({
        filePath,
        line: caught.line,
        message: "empty catch silently swallows awaited work",
      });
    }
  }
  return { scriptFiles, htmlFiles, inlineScripts: units.filter(unit => unit.inline).length, issues };
}

function runRepositoryCheck() {
  const { scriptFiles, htmlFiles, inlineScripts, issues } = checkFrontendBindings();
  if (issues.length) {
    console.error("Frontend binding check failed:");
    for (const issue of issues) {
      const relativePath = path.relative(repositoryRoot, issue.filePath).split(path.sep).join("/");
      console.error(`- ${relativePath}:${issue.line} ${issue.message}`);
    }
    process.exitCode = 1;
    return;
  }
  console.log(
    `[frontend-bindings] ${scriptFiles.length} scripts/modules and ${inlineScripts} inline scripts in ${htmlFiles.length} HTML files contain no unresolved references, unused bindings or silent awaited catches.`
  );
}

async function readStandardInput() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

async function runAnalysisMode(mode) {
  const source = await readStandardInput();
  const analyzers = {
    unused: findUnusedBindings,
    parameters: findUnmarkedUnusedParameters,
    catches: findSilentAwaitCatches,
    unresolved: findUnresolvedReferences,
  };
  const analyze = analyzers[mode];
  if (!analyze) throw new Error(`Unknown frontend binding analysis mode: ${mode}`);
  process.stdout.write(`${JSON.stringify(analyze(source))}\n`);
}

if (process.argv[1] === scriptPath) {
  const analysisFlag = process.argv.indexOf("--analyze");
  if (analysisFlag >= 0) {
    await runAnalysisMode(process.argv[analysisFlag + 1]);
  } else {
    runRepositoryCheck();
  }
}

export {
  checkFrontendBindings,
  findSilentAwaitCatches,
  findUnmarkedUnusedParameters,
  findUnusedBindings,
  findUnresolvedReferences,
  htmlScripts,
  isExportedBinding,
};
