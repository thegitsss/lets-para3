const fs = require("fs");
const path = require("path");
const { parse } = require("@babel/parser");
const traverse = require("@babel/traverse").default;

const repositoryRoot = path.resolve(__dirname, "../..");
const frontendRoot = path.join(repositoryRoot, "frontend");
const scriptsRoot = path.join(frontendRoot, "assets", "scripts");
const stylesRoot = path.join(frontendRoot, "assets", "styles");
const SOURCE_EXTENSIONS = new Set([".html", ".js", ".mjs", ".css"]);
const SCRIPT_EXTENSIONS = new Set([".js", ".mjs"]);
const webAuthnVersion = JSON.parse(fs.readFileSync(path.join(repositoryRoot, "backend/node_modules/@simplewebauthn/browser/package.json"), "utf8")).version;
const VIRTUAL_FRONTEND_ASSETS = new Map([
  [
    "/assets/vendor/chart-4.5.1.js",
    path.join(repositoryRoot, "backend", "node_modules", "chart.js", "dist", "chart.umd.js"),
  ],
  [
    `/assets/vendor/simplewebauthn-${webAuthnVersion}.js`,
    path.join(repositoryRoot, "backend", "node_modules", "@simplewebauthn", "browser", "dist", "bundle", "index.umd.min.js"),
  ],
  [
    "/assets/vendor/web-vitals-6.1.1.js",
    path.join(repositoryRoot, "backend", "node_modules", "web-vitals", "dist", "web-vitals.js"),
  ],
]);

function walk(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(directory, entry.name);
    return entry.isDirectory() ? walk(target) : [target];
  });
}

function relative(filePath) {
  return path.relative(repositoryRoot, filePath).split(path.sep).join("/");
}

function stripUrlSuffix(value = "") {
  return String(value).split("#")[0].split("?")[0].trim();
}

function isExternalReference(value = "") {
  return /^(?:[a-z]+:|\/\/|#|mailto:|tel:|javascript:)/i.test(String(value).trim());
}

function resolveFrontendReference(htmlPath, value = "") {
  const clean = stripUrlSuffix(value);
  if (!clean || isExternalReference(clean) || clean.includes("${")) return null;
  if (VIRTUAL_FRONTEND_ASSETS.has(clean)) return VIRTUAL_FRONTEND_ASSETS.get(clean);
  return clean.startsWith("/")
    ? path.join(frontendRoot, clean.slice(1))
    : path.resolve(path.dirname(htmlPath), clean);
}

function collectHtmlAssetReferences(htmlPath) {
  const source = fs.readFileSync(htmlPath, "utf8");
  const references = [];
  const tagPattern = /<(script|link|img|source)\b[^>]*?\b(src|href)=["']([^"']+)["'][^>]*>/gi;
  for (const match of source.matchAll(tagPattern)) {
    const [, tag, attribute, value] = match;
    if (tag.toLowerCase() === "link" && attribute.toLowerCase() === "href") {
      const fullTag = match[0];
      if (!/\brel=["'][^"']*(?:stylesheet|icon|manifest|preload|modulepreload)[^"']*["']/i.test(fullTag)) {
        continue;
      }
    }
    const resolved = resolveFrontendReference(htmlPath, value);
    if (resolved) references.push({ htmlPath, value, resolved });
  }
  for (const match of source.matchAll(/<(?:img|source)\b[^>]*?\bsrcset=["']([^"']+)["'][^>]*>/gi)) {
    for (const candidate of match[1].split(",")) {
      const value = candidate.trim().split(/\s+/, 1)[0];
      const resolved = resolveFrontendReference(htmlPath, value);
      if (resolved) references.push({ htmlPath, value, resolved });
    }
  }
  return references;
}

function collectCssAssetReferences(stylePath) {
  const source = fs.readFileSync(stylePath, "utf8");
  const references = [];
  for (const match of source.matchAll(/\burl\(\s*(["']?)([^"')]+)\1\s*\)/gi)) {
    const value = match[2].trim();
    if (!value || /^(?:data:|blob:|var\(|#)/i.test(value)) continue;
    const resolved = resolveFrontendReference(stylePath, value);
    if (resolved) references.push({ htmlPath: stylePath, value, resolved });
  }
  return references;
}

function clientSessionCompatibilityIssue(source = "") {
  if (/\bgetSessionToken\b|__cookie_session__/.test(source)) {
    return "uses the retired client session-token compatibility API";
  }
  if (
    /\b(?:localStorage|sessionStorage)\.getItem\(\s*["'](?:lpc_token|token|auth_token|LPC_JWT|lpc_jwt)["']\s*\)/.test(
      source
    )
  ) {
    return "reads a retired browser authentication token";
  }
  if (/\bAuthorization\s*:\s*`Bearer\s+\$\{/.test(source)) {
    return "constructs a browser Bearer header instead of using the managed session cookie";
  }
  return "";
}

function unsafeErrorHtmlInterpolation(source = "") {
  return /\binnerHTML\s*=\s*`[\s\S]{0,240}\$\{\s*(?:err|error)\??\.message\b/.test(source);
}

function unsafeDynamicValueAttributes(source = "") {
  const unsafe = [];
  const pattern = /\bvalue\s*=\s*["']\$\{([^}\n]+)\}["']/g;
  for (const match of String(source).matchAll(pattern)) {
    const expression = match[1].trim();
    if (/\b(?:escapeHTML|escapeHtml|escapeAttribute|escapeAttr|sanitize|CSS\.escape)\s*\(/.test(expression)) continue;
    unsafe.push(expression);
  }
  return unsafe;
}

function unsafeServerNavigation(source = "") {
  return /(?:window\.location(?:\.href)?\s*=|window\.location\.(?:assign|replace)\s*\(|window\.open\s*\()\s*(?:data|payload|response)\??\.(?:url|connectUrl)\b/.test(
    String(source)
  );
}

function unauthorizedSessionSnapshotWrite(source = "", sourcePath = "") {
  const writesSessionSnapshot = /\blocalStorage\.setItem\(\s*["']lpc_user["']\s*,/.test(String(source));
  if (!writesSessionSnapshot) return false;
  const normalizedPath = String(sourcePath).split(path.sep).join("/");
  return !normalizedPath.endsWith("frontend/assets/scripts/utils/session.js");
}

function persistentSensitiveBrowserDataIssue(source = "") {
  const value = String(source);
  return (
    /\blocalStorage\.(?:getItem|setItem)\(\s*["'](?:lastEmail|avatarURL|lpc_edit_profile_prefill|lpc-support-context)["']/.test(value) ||
    /\b(?:localStorage|sessionStorage)\.(?:getItem|setItem)\(\s*["'](?:lpc_case_edit_prefill|lpc_case_preview_id|lpc_case_preview_receipt)["']/.test(value)
  );
}

function unauthorizedLogoutRequest(source = "", sourcePath = "") {
  if (!/["']\/api\/auth\/logout["']/.test(String(source))) return false;
  const normalizedPath = String(sourcePath).split(path.sep).join("/");
  return ![
    "frontend/assets/scripts/auth.js",
    "frontend/assets/scripts/utils/session.js",
  ].some((allowed) => normalizedPath.endsWith(allowed));
}

function destructiveBrowserStorageClear(source = "") {
  return /\b(?:localStorage|sessionStorage)\.clear\s*\(/.test(String(source));
}

function persistentAttachmentDraftIssue(source = "") {
  return /indexedDB\.open\(\s*["']lpc_case_attachments["']|\bblob\s*:\s*entry\.file\b/.test(String(source));
}

function rawApiMutationIssue(source = "", sourcePath = "") {
  const hasRawMutation = /\bfetch\(\s*["'`]\/api\/[\s\S]{0,600}?\bmethod\s*:\s*["'](?:POST|PUT|PATCH|DELETE)["']/.test(
    String(source)
  );
  if (!hasRawMutation) return false;
  const normalizedPath = String(sourcePath).split(path.sep).join("/");
  return ![
    "frontend/contact.html",
    "frontend/forgot-password.html",
    "frontend/assets/scripts/help-incident-intake.js",
    "frontend/assets/scripts/reset-password.js",
    "frontend/assets/scripts/verify-email.js",
    "frontend/assets/scripts/web-vitals-rum.js",
    "frontend/assets/scripts/utils/session.js",
  ].some((allowed) => normalizedPath.endsWith(allowed));
}

function runtimePlaceholderLinkIssue(source = "") {
  const value = String(source);
  return [
    /\.href\s*=\s*[^;\n]{0,300}(?:(?:\|\|)|:)\s*["']#["']/i,
    /\bhref\s*=\s*["']\$\{[^}\n]{0,300}(?:(?:\|\|)|:)\s*["']#["'][^}\n]*\}["']/i,
    /\b(?:const|let|var)\s+\w*(?:href|link|url)\w*\s*=\s*[^;\n]{0,300}(?:(?:\|\|)|:)\s*["']#["']/i,
    /\breturn\s+["']#["']\s*;/i,
  ].some((pattern) => pattern.test(value));
}

function silentAsyncFailureIssue(source = "", sourcePath = "") {
  if (!/\.catch\(\s*\(\)\s*=>\s*\{\s*\}\s*\)/.test(String(source))) return false;
  const normalizedPath = String(sourcePath).split(path.sep).join("/");
  return !normalizedPath.endsWith("frontend/assets/scripts/web-vitals-rum.js");
}

function unboundedCssTransitionIssue(source = "") {
  return /\btransition(?:-property)?\s*:\s*all\b/i.test(String(source));
}

function generatedCssWrapperIssue(source = "", sourcePath = "") {
  if (path.extname(sourcePath) !== ".css") return false;
  return /^(?:\s*```(?:css)?\s*$|\s*\/\/|\s*(?:Absolutely|Sure)[—,!:.\s])/im.test(String(source));
}

function nativeDialogIssue(source = "", sourcePath = "") {
  const value = String(source), nativeNames = new Set(["alert", "confirm", "prompt"]);
  if (path.extname(sourcePath) === ".css") return false;
  const candidates = path.extname(sourcePath) === ".html" || /^\s*(?:<!doctype\s+html|<html\b|<script\b)/i.test(value)
    ? [...value.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)].filter(match => !/\btype\s*=\s*["'](?:importmap|application\/(?:ld\+)?json)["']/i.test(match[1])).map(match => match[2])
    : [value];
  return candidates.some(candidate => {
    if (!/\b(?:alert|confirm|prompt)\b/.test(candidate)) return false;
    let found = false;
    try {
      const ast = parse(candidate, { sourceType: "unambiguous" });
      traverse(ast, {
        "CallExpression|OptionalCallExpression"(call) {
          const callee = call.node.callee;
          if (callee.type === "Identifier" && nativeNames.has(callee.name) && !call.scope.getBinding(callee.name)) found = true;
          if (["MemberExpression", "OptionalMemberExpression"].includes(callee.type)) {
            const object = callee.object, name = callee.computed ? callee.property.value : callee.property.name;
            if (object.type === "Identifier" && ["window", "globalThis", "self"].includes(object.name) && !call.scope.getBinding(object.name) && nativeNames.has(name)) found = true;
          }
        },
      });
    } catch {
      // Syntax has a separate gate; do not excuse a native call in invalid code.
      return /(?:^|[^\w.])(?:window\s*\.\s*)?(?:alert|confirm|prompt)\s*\(/m.test(candidate);
    }
    return found;
  });
}

function remoteVisualAssetIssue(source = "", sourcePath = "") {
  const value = String(source);
  if (path.extname(sourcePath) === ".css") {
    return /\burl\(\s*["']?(?:https?:)?\/\//i.test(value);
  }
  return (
    /<(?:img|source|video)\b[^>]*\b(?:src|srcset|poster)\s*=\s*["'](?:https?:)?\/\//i.test(value) ||
    /\.(?:src|poster)\s*=\s*["'](?:https?:)?\/\//i.test(value)
  );
}

function duplicatedAvatarFallbackIssue(source = "") {
  const value = String(source);
  return (
    /\b(?:const|let|var)\s+\w*avatar\w*\s*=\s*`data:image\/svg\+xml/i.test(value) ||
    /function\s+\w*avatar\w*\([^)]*\)[\s\S]{0,800}?return\s+`data:image\/svg\+xml/i.test(value)
  );
}

function duplicateStaticIds(source = "") {
  const markup = String(source)
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, "")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, "");
  const seen = new Set();
  const duplicates = new Set();
  const pattern = /\bid\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>"']+))/gi;
  for (const match of markup.matchAll(pattern)) {
    const id = match[1] || match[2] || match[3] || "";
    if (!id) continue;
    if (seen.has(id)) duplicates.add(id);
    seen.add(id);
  }
  return [...duplicates].sort();
}

function markupWithoutExecutableContent(source = "") {
  return String(source)
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, "")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, "");
}

function declaredIds(source = "") {
  const ids = new Set();
  const pattern = /\bid\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>"']+))/gi;
  for (const match of String(source).matchAll(pattern)) {
    const value = match[1] || match[2] || match[3] || "";
    if (value && !value.includes("${")) ids.add(value);
  }
  return ids;
}

function resolveNavigationTarget(htmlPath, value = "") {
  const raw = String(value).trim();
  if (!raw || raw.includes("${") || /^(?:[a-z]+:|\/\/|\/api\/)/i.test(raw)) return null;
  const [pathPart, fragment = ""] = raw.split("#", 2);
  const cleanPath = pathPart.split("?")[0];
  let targetPath = htmlPath;
  if (cleanPath === "/") targetPath = path.join(frontendRoot, "index.html");
  else if (cleanPath) {
    targetPath = cleanPath.startsWith("/")
      ? path.join(frontendRoot, cleanPath.slice(1))
      : path.resolve(path.dirname(htmlPath), cleanPath);
  }
  return { targetPath, fragment };
}

function documentSupportsFragment(source = "", fragment = "", htmlPath = "") {
  const value = String(fragment).trim();
  if (!value) return true;
  if (declaredIds(source).has(value)) return true;
  const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (new RegExp(`\\bdata-(?:view|step|view-link|section)\\s*=\\s*["']${escaped}["']`, "i").test(source)) return true;
  if (value.startsWith("/")) {
    // V2 renders route contents dynamically. Validate against its actual parser,
    // only when this document mounts the corresponding application entry point.
    for (const role of ["attorney", "paralegal"]) {
      if (htmlPath !== path.join(frontendRoot, `${role}-v2.html`)) continue;
      const appPath = path.join(scriptsRoot, `${role}-v2/app.mjs`);
      const mounted = collectHtmlAssetReferences(htmlPath).some(reference => reference.resolved === appPath)
        && [...source.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi)]
          .some(match => resolveFrontendReference(htmlPath, match[1]) === appPath);
      if (!mounted) continue;
      const routes = require(path.join(scriptsRoot, `${role}-v2/${role === "attorney" ? "routes" : "router"}.mjs`));
      const parseRoute = role === "attorney" ? routes.parseRoute : routes.parseRouteHash;
      if (parseRoute(`#${value}`).found === true) return true;
    }
    const routePath = value.split("?")[0];
    for (const match of source.matchAll(/\bdata-view\s*=\s*["']([^"']+)["']/gi)) {
      if (match[1].split("?")[0] === routePath) return true;
    }
  }

  const [view, filter, ...extra] = value.split(":");
  if (filter && !extra.length) {
    const escapedView = view.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const escapedFilter = filter.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return (
      new RegExp(`\\bdata-view\\s*=\\s*["']${escapedView}["']`, "i").test(source) &&
      new RegExp(`\\bdata-case-filter\\s*=\\s*["']${escapedFilter}["']`, "i").test(source)
    );
  }

  const executable = [...String(source).matchAll(/<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi)]
    .map((match) => match[1])
    .join("\n");
  return executable.includes(`"#${value}"`) || executable.includes(`'#${value}'`);
}

function staticDocumentRelationshipIssues(htmlPath, source = "") {
  const issues = [];
  const markup = markupWithoutExecutableContent(source);
  const ids = declaredIds(source);

  for (const match of markup.matchAll(/<a\b[^>]*\bhref\s*=\s*(?:"([^"]*)"|'([^']*)')[^>]*>/gi)) {
    const href = String(match[1] ?? match[2] ?? "").trim();
    if (!href) {
      issues.push("contains an empty link destination");
      continue;
    }
    if (/^javascript:/i.test(href)) {
      issues.push("contains a javascript: link destination");
      continue;
    }
    const resolved = resolveNavigationTarget(htmlPath, href);
    if (!resolved) continue;
    if (!resolved.targetPath.startsWith(frontendRoot)) {
      issues.push(`link escapes the frontend root: ${href}`);
      continue;
    }
    if (!fs.existsSync(resolved.targetPath) || !fs.statSync(resolved.targetPath).isFile()) {
      issues.push(`references missing navigation target ${href}`);
      continue;
    }
    if (resolved.fragment) {
      let fragment = resolved.fragment;
      try {
        fragment = decodeURIComponent(fragment);
      } catch {
        issues.push(`contains an invalid encoded fragment ${href}`);
        continue;
      }
      const targetSource = resolved.targetPath === htmlPath
        ? source
        : fs.readFileSync(resolved.targetPath, "utf8");
      if (!documentSupportsFragment(targetSource, fragment, resolved.targetPath)) {
        issues.push(`references missing fragment ${href}`);
      }
    }
  }

  for (const match of markup.matchAll(/<label\b[^>]*\bfor\s*=\s*(?:"([^"]+)"|'([^']+)')[^>]*>/gi)) {
    const target = match[1] || match[2] || "";
    if (target && !target.includes("${") && !ids.has(target)) {
      issues.push(`label references missing id ${target}`);
    }
  }

  for (const match of markup.matchAll(/\baria-(?:controls|describedby|labelledby|owns)\s*=\s*(?:"([^"]+)"|'([^']+)')/gi)) {
    const value = match[1] || match[2] || "";
    if (value.includes("${")) continue;
    value.trim().split(/\s+/).filter(Boolean).forEach((target) => {
      if (!ids.has(target)) issues.push(`ARIA relationship references missing id ${target}`);
    });
  }

  return [...new Set(issues)].sort();
}

function listFrontendScripts() {
  return new Set(walk(scriptsRoot).filter(file => SCRIPT_EXTENSIONS.has(path.extname(file))));
}

function collectReachableScripts(htmlFiles) {
  const reachable = new Set(), importsByFile = new Map();
  const importsIn = source => {
    const values = [];
    const ast = parse(source, { sourceType: "unambiguous" });
    traverse(ast, {
      "ImportDeclaration|ExportNamedDeclaration|ExportAllDeclaration"(entry) {
        if (entry.node.source) values.push(entry.node.source.value);
      },
      CallExpression(entry) {
        if (entry.node.callee.type === "Import" && entry.node.arguments[0]?.type === "StringLiteral") values.push(entry.node.arguments[0].value);
      },
      ImportExpression(entry) { if (entry.node.source.type === "StringLiteral") values.push(entry.node.source.value); },
    });
    return values;
  };
  for (const htmlPath of htmlFiles) {
    const source = fs.readFileSync(htmlPath, "utf8"), mappings = new Map(), queue = [], visited = new Set();
    const scripts = [...source.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)];
    const keyFor = (importer, value) => value.startsWith(".") ? "/" + path.relative(frontendRoot, path.resolve(path.dirname(importer), value)).split(path.sep).join("/") : value;
    for (const script of scripts) {
      if (!/\btype\s*=\s*["']importmap["']/i.test(script[1])) continue;
      const map = JSON.parse(script[2]);
      for (const [key, value] of Object.entries(map.imports || {})) mappings.set(keyFor(htmlPath, key), value);
    }
    const enqueue = (importer, value, mapped = true) => {
      let specifier = stripUrlSuffix(value), base = importer;
      const key = keyFor(importer, specifier);
      if (mapped && mappings.has(key)) { specifier = mappings.get(key); base = htmlPath; }
      if (typeof specifier !== "string" || !specifier || /^(?:[a-z]+:|\/\/)/i.test(specifier)) return;
      if (!specifier.startsWith("/") && !specifier.startsWith(".")) return;
      const resolved = resolveFrontendReference(base, specifier);
      if (resolved?.startsWith(scriptsRoot + path.sep) && SCRIPT_EXTENSIONS.has(path.extname(resolved)) && fs.existsSync(resolved)) queue.push(resolved);
    };
    for (const script of scripts) {
      if (/\btype\s*=\s*["'](?:importmap|application\/(?:ld\+)?json)["']/i.test(script[1])) continue;
      const src = script[1].match(/\bsrc\s*=\s*["']([^"']+)["']/i)?.[1];
      if (src) enqueue(htmlPath, src.startsWith(".") || src.startsWith("/") || /^[a-z]+:/i.test(src) ? src : "./" + src, false);
      else for (const value of importsIn(script[2])) enqueue(htmlPath, value);
    }
    while (queue.length) {
      const scriptPath = queue.pop();
      if (visited.has(scriptPath)) continue;
      visited.add(scriptPath); reachable.add(scriptPath);
      if (!importsByFile.has(scriptPath)) importsByFile.set(scriptPath, importsIn(fs.readFileSync(scriptPath, "utf8")));
      for (const value of importsByFile.get(scriptPath)) enqueue(scriptPath, value);
    }
  }
  return reachable;
}

function collectServerReachableScripts() {
  const { reachableFiles } = require("./check-backend-reachability");
  return new Set([...reachableFiles({ dependencyRoot: repositoryRoot })]
    .filter(file => file.startsWith(scriptsRoot + path.sep) && SCRIPT_EXTENSIONS.has(path.extname(file))));
}

function collectReachableStyles(htmlFiles, reachableScripts = new Set()) {
  const reachable = new Set();
  const queue = [];
  for (const htmlPath of htmlFiles) {
    const source = fs.readFileSync(htmlPath, "utf8");
    for (const match of source.matchAll(/<link[^>]+href=["']([^"']+\.css)(?:\?[^"']*)?["']/gi)) {
      const resolved = resolveFrontendReference(htmlPath, match[1]);
      if (resolved?.startsWith(stylesRoot) && fs.existsSync(resolved)) queue.push(resolved);
    }
  }
  for (const scriptPath of reachableScripts) {
    const source = fs.readFileSync(scriptPath, "utf8");
    for (const match of source.matchAll(/["']([^"']+\.css(?:\?[^"']*)?)["']/gi)) {
      const clean = stripUrlSuffix(match[1]);
      const resolved = clean.startsWith("/")
        ? path.join(frontendRoot, clean.slice(1))
        : path.resolve(path.dirname(scriptPath), clean);
      if (resolved.startsWith(stylesRoot) && fs.existsSync(resolved)) queue.push(resolved);
    }
  }
  while (queue.length) {
    const stylePath = queue.pop();
    if (reachable.has(stylePath)) continue;
    reachable.add(stylePath);
    const source = fs.readFileSync(stylePath, "utf8");
    for (const match of source.matchAll(/@import\s+(?:url\()?\s*["']?([^"')\s]+\.css)/gi)) {
      const imported = path.resolve(path.dirname(stylePath), stripUrlSuffix(match[1]));
      if (imported.startsWith(stylesRoot) && fs.existsSync(imported)) queue.push(imported);
    }
  }
  return reachable;
}

function listFrontendStyles() {
  return new Set(walk(stylesRoot).filter(file => path.extname(file) === ".css"));
}

function runChecks() {
  const failures = [];
  const allFrontendFiles = walk(frontendRoot);
  const htmlFiles = allFrontendFiles.filter((filePath) => path.extname(filePath) === ".html");
  const cssFiles = allFrontendFiles.filter((filePath) => path.extname(filePath) === ".css");
  const sourceFiles = allFrontendFiles.filter((filePath) => SOURCE_EXTENSIONS.has(path.extname(filePath)));
  const references = [
    ...htmlFiles.flatMap(collectHtmlAssetReferences),
    ...cssFiles.flatMap(collectCssAssetReferences),
  ];

  for (const reference of references) {
    const virtualAsset = [...VIRTUAL_FRONTEND_ASSETS.values()].includes(reference.resolved);
    if (!reference.resolved.startsWith(frontendRoot) && !virtualAsset) {
      failures.push(`${relative(reference.htmlPath)} escapes the frontend root: ${reference.value}`);
      continue;
    }
    if (!fs.existsSync(reference.resolved)) {
      failures.push(`${relative(reference.htmlPath)} references missing asset ${reference.value}`);
      continue;
    }
    if (fs.statSync(reference.resolved).isFile() && fs.statSync(reference.resolved).size === 0) {
      failures.push(`${relative(reference.htmlPath)} references empty asset ${relative(reference.resolved)}`);
    }
  }

  for (const sourcePath of sourceFiles) {
    const source = fs.readFileSync(sourcePath, "utf8");
    if (/via\.placeholder\.com/i.test(source)) {
      failures.push(`${relative(sourcePath)} depends on a remote placeholder service`);
    }
    if (/(?:assets\/default-avatar\.png|["']default\.jpg["'])/i.test(source)) {
      failures.push(`${relative(sourcePath)} references a retired or missing default avatar`);
    }
    if (/[a-z0-9._%+-]+@gmail\.com/i.test(source)) {
      failures.push(`${relative(sourcePath)} contains a personal-email feature switch`);
    }
    const sessionCompatibilityIssue = clientSessionCompatibilityIssue(source);
    if (sessionCompatibilityIssue) {
      failures.push(`${relative(sourcePath)} ${sessionCompatibilityIssue}`);
    }
    if (unsafeErrorHtmlInterpolation(source)) {
      failures.push(`${relative(sourcePath)} interpolates an unescaped error message into HTML`);
    }
    const unsafeValueAttributes = unsafeDynamicValueAttributes(source);
    if (unsafeValueAttributes.length) {
      failures.push(`${relative(sourcePath)} interpolates unescaped dynamic form values: ${unsafeValueAttributes.join(", ")}`);
    }
    if (unsafeServerNavigation(source)) {
      failures.push(`${relative(sourcePath)} navigates directly to a server-provided URL without URL policy validation`);
    }
    if (unauthorizedSessionSnapshotWrite(source, sourcePath)) {
      failures.push(`${relative(sourcePath)} writes the session snapshot outside the centralized projection boundary`);
    }
    if (persistentSensitiveBrowserDataIssue(source)) {
      failures.push(`${relative(sourcePath)} persistently stores browser data that must be session-scoped or projected`);
    }
    if (unauthorizedLogoutRequest(source, sourcePath)) {
      failures.push(`${relative(sourcePath)} bypasses the centralized CSRF-protected logout contract`);
    }
    if (destructiveBrowserStorageClear(source)) {
      failures.push(`${relative(sourcePath)} clears all browser storage instead of removing owned keys`);
    }
    if (persistentAttachmentDraftIssue(source)) {
      failures.push(`${relative(sourcePath)} persistently stores an unsent Matter attachment blob`);
    }
    if (rawApiMutationIssue(source, sourcePath)) {
      failures.push(`${relative(sourcePath)} sends an application API mutation outside the centralized request contract`);
    }
    if (runtimePlaceholderLinkIssue(source)) {
      failures.push(`${relative(sourcePath)} generates a placeholder # link for a runtime action`);
    }
    if (silentAsyncFailureIssue(source, sourcePath)) {
      failures.push(`${relative(sourcePath)} silently discards an asynchronous UI failure`);
    }
    if (unboundedCssTransitionIssue(source)) {
      failures.push(`${relative(sourcePath)} uses transition: all instead of explicit compositor-safe properties`);
    }
    if (generatedCssWrapperIssue(source, sourcePath)) {
      failures.push(`${relative(sourcePath)} contains a generated-response wrapper or non-CSS comment`);
    }
    if (remoteVisualAssetIssue(source, sourcePath)) {
      failures.push(`${relative(sourcePath)} references a mutable remote visual asset`);
    }
    if (duplicatedAvatarFallbackIssue(source)) {
      failures.push(`${relative(sourcePath)} embeds a duplicate avatar SVG instead of the canonical local fallback`);
    }
    if (/\b(?:coming soon|available soon|not implemented|under construction|not available yet)\b/i.test(source)) {
      failures.push(`${relative(sourcePath)} exposes unfinished product copy or behavior`);
    }
    if (/\bDEMO_(?:MODE|DATA|RECORDS)\b|URLSearchParams[^\n]{0,160}\.get\(["']demo["']\)/i.test(source)) {
      failures.push(`${relative(sourcePath)} exposes query-controlled demo data in a production surface`);
    }
    if (/href\s*=\s*["']#["']|\.href\s*=\s*["']#["']|setAttribute\(["']href["']\s*,\s*["']#["']\)/i.test(source)) {
      failures.push(`${relative(sourcePath)} uses a placeholder # link instead of a real destination or button`);
    }
    if (/<[^>]+\son(?:click|change|input|submit|keydown|keyup|mousedown|mouseup|focus|blur)\s*=/i.test(source)) {
      failures.push(`${relative(sourcePath)} contains an inline event handler`);
    }
    if (/\.(?:onchange|onclick|onsubmit|onkeydown|onkeyup)\s*=(?!=)/i.test(source)) {
      failures.push(`${relative(sourcePath)} assigns a DOM event handler property instead of using addEventListener`);
    }
    if (nativeDialogIssue(source, sourcePath)) {
      failures.push(`${relative(sourcePath)} uses a native browser dialog instead of the accessible product dialog system`);
    }
  }

  for (const htmlPath of htmlFiles) {
    const source = fs.readFileSync(htmlPath, "utf8");
    const duplicateIds = duplicateStaticIds(source);
    if (duplicateIds.length) {
      failures.push(`${relative(htmlPath)} contains duplicate static ids: ${duplicateIds.join(", ")}`);
    }
    staticDocumentRelationshipIssues(htmlPath, source).forEach((issue) => {
      failures.push(`${relative(htmlPath)} ${issue}`);
    });
    if (!/<main\b[^>]*\bid=["']main["'][^>]*>/i.test(source)) {
      failures.push(`${relative(htmlPath)} must expose a semantic <main id="main"> landmark`);
    }
    if (!/<a\b(?=[^>]*\bclass=["'][^"']*\bskip-link\b[^"']*["'])(?=[^>]*\bhref=["']#main["'])[^>]*>/i.test(source)) {
      failures.push(`${relative(htmlPath)} must expose a skip link to #main`);
    }
    for (const match of source.matchAll(/<button\b[^>]*>/gi)) {
      if (!/\btype\s*=\s*["'](?:button|submit|reset)["']/i.test(match[0])) {
        failures.push(`${relative(htmlPath)} contains a button without an explicit type`);
        break;
      }
    }
    for (const match of source.matchAll(/<img\b[^>]*>/gi)) {
      if (!/\balt\s*=\s*["'][^"']*["']/i.test(match[0])) {
        failures.push(`${relative(htmlPath)} contains an image without an alt attribute`);
        break;
      }
    }
  }

  const reachable = new Set([...collectReachableScripts(htmlFiles), ...collectServerReachableScripts()]);
  for (const scriptPath of listFrontendScripts()) {
    if (fs.existsSync(scriptPath) && !reachable.has(scriptPath)) {
      failures.push(`${relative(scriptPath)} is an orphan module with no production entry point`);
    }
  }
  const reachableStyles = collectReachableStyles(htmlFiles, reachable);
  for (const stylePath of listFrontendStyles()) {
    if (fs.existsSync(stylePath) && !reachableStyles.has(stylePath)) {
      failures.push(`${relative(stylePath)} is an orphan stylesheet with no production entry point`);
    }
  }

  if (failures.length) {
    console.error("Frontend hygiene check failed:\n" + failures.map((failure) => `- ${failure}`).join("\n"));
    process.exitCode = 1;
    return;
  }

  console.log(
    `Frontend hygiene check passed (${htmlFiles.length} HTML entry points, ${references.length} local asset references, ${reachable.size} reachable modules, ${reachableStyles.size} reachable stylesheets).`
  );
}

if (require.main === module) runChecks();

module.exports = {
  collectHtmlAssetReferences,
  collectCssAssetReferences,
  collectReachableScripts,
  collectServerReachableScripts,
  collectReachableStyles,
  clientSessionCompatibilityIssue,
  duplicateStaticIds,
  staticDocumentRelationshipIssues,
  unsafeErrorHtmlInterpolation,
  unsafeDynamicValueAttributes,
  unsafeServerNavigation,
  unauthorizedSessionSnapshotWrite,
  persistentSensitiveBrowserDataIssue,
  unauthorizedLogoutRequest,
  destructiveBrowserStorageClear,
  persistentAttachmentDraftIssue,
  rawApiMutationIssue,
  runtimePlaceholderLinkIssue,
  silentAsyncFailureIssue,
  unboundedCssTransitionIssue,
  generatedCssWrapperIssue,
  nativeDialogIssue,
  remoteVisualAssetIssue,
  duplicatedAvatarFallbackIssue,
  resolveFrontendReference,
  runChecks,
};
