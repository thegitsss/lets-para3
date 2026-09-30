const fs = require("fs"), path = require("path");
const { minify } = require("terser");
const CleanCSS = require("clean-css");
const { parse } = require("@babel/parser");
const { PROJECT_ROOT, BUILD_OWNER, digest, filesIn, recipeFor, verifyFrontendBuild } = require("../utils/frontendAssets");
const MINIFY_OPTIONS = Object.freeze({ compress: false, mangle: false, keep_fnames: true, keep_classnames: true, format: { comments: "some", semicolons: true } });

async function buildFrontend(projectRoot = PROJECT_ROOT) {
  const sourceRoot = path.join(projectRoot, "frontend"), outputRoot = path.join(projectRoot, ".lpc-build");
  if (fs.existsSync(outputRoot)) {
    if (fs.lstatSync(outputRoot).isSymbolicLink()) throw new Error("Refusing to replace a symbolic-link build directory.");
    let previous;
    try { previous = JSON.parse(fs.readFileSync(path.join(outputRoot, "manifest.json"), "utf8")); }
    catch (_) { throw new Error("Refusing to replace a build directory without an LPC build manifest."); }
    if (previous.owner !== BUILD_OWNER || previous.version !== 1) throw new Error("Refusing to replace an unrecognized build directory.");
  }
  const declaredVersion = JSON.parse(fs.readFileSync(path.join(projectRoot, "backend/package.json"), "utf8")).devDependencies?.terser;
  const installedVersion = require("terser/package.json").version;
  if (declaredVersion !== installedVersion) throw new Error("Install the exact pinned frontend minifier before building.");
  const cssVersion = require("clean-css/package.json").version;
  const declaredCssVersion = JSON.parse(fs.readFileSync(path.join(projectRoot, "backend/package.json"), "utf8")).devDependencies?.["clean-css"];
  if (declaredCssVersion !== cssVersion) throw new Error("Install the exact pinned CSS minifier before building.");
  const recipe = recipeFor(projectRoot);
  const temporary = fs.mkdtempSync(path.join(projectRoot, ".lpc-build-")), files = [];
  const previousRoot = temporary + "-previous";
  let movedPrevious = false;
  try {
    for (const relative of filesIn(sourceRoot, { source: true })) {
      const source = fs.readFileSync(path.join(sourceRoot, relative));
      let output = source;
      if (relative.startsWith("assets/scripts/") && /\.(mjs|js)$/.test(relative)) {
        const text = source.toString("utf8");
        const module = parse(text, { sourceType: "unambiguous" }).program.sourceType === "module";
        const result = await minify(text, { ...MINIFY_OPTIONS, module });
        output = Buffer.from(result.code + "\n");
      }
      if (relative.endsWith(".css")) {
        const result = new CleanCSS({ level: 0, inline: false, rebase: false }).minify(source.toString("utf8"));
        if (result.errors.length) throw new Error(`CSS build failed for ${relative}: ${result.errors.join("; ")}`);
        output = Buffer.from(result.styles + "\n");
      }
      const target = path.join(temporary, "frontend", relative);
      fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, output);
      files.push({ path: relative, sourceHash: digest(source), outputHash: digest(output), sourceBytes: source.length, outputBytes: output.length });
    }
    const manifest = { owner: BUILD_OWNER, version: 1, minifier: installedVersion, cssMinifier: cssVersion, recipe, files };
    fs.writeFileSync(path.join(temporary, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
    if (fs.existsSync(outputRoot)) { fs.renameSync(outputRoot, previousRoot); movedPrevious = true; }
    fs.renameSync(temporary, outputRoot);
    try { verifyFrontendBuild(projectRoot); }
    catch (error) {
      fs.rmSync(outputRoot, { recursive: true });
      if (movedPrevious) { fs.renameSync(previousRoot, outputRoot); movedPrevious = false; }
      throw error;
    }
    if (movedPrevious) fs.rmSync(previousRoot, { recursive: true });
    return manifest;
  } catch (error) {
    // Only directories created by this invocation are removed. A prior valid
    // build survives a failed parse or incomplete artifact publication.
    if (fs.existsSync(temporary)) fs.rmSync(temporary, { recursive: true });
    if (movedPrevious && !fs.existsSync(outputRoot)) fs.renameSync(previousRoot, outputRoot);
    throw error;
  }
}

if (require.main === module) buildFrontend().then(manifest => {
  const bytes = manifest.files.reduce((sum, file) => sum + file.outputBytes, 0);
  console.log(`[frontend-build] ${manifest.files.length} files, ${(bytes / 1024).toFixed(1)} KiB; current source and output verified.`);
}).catch(error => { console.error(error.message); process.exitCode = 1; });

module.exports = { buildFrontend, MINIFY_OPTIONS };
