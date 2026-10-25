const fs = require("fs"), path = require("path"), crypto = require("crypto");
const PROJECT_ROOT = path.resolve(__dirname, "../..");
const BUILD_OWNER = "lpc-frontend-build";
const RECIPE_INPUTS = ["backend/scripts/build-frontend.js", "backend/utils/frontendAssets.js", "backend/package.json", "backend/package-lock.json"];
const digest = value => crypto.createHash("sha256").update(value).digest("hex");
const fail = detail => { throw new Error(`Frontend build ${detail}. Run npm run build:frontend.`); };

function filesIn(root, { source = false } = {}) {
  if (fs.lstatSync(root).isSymbolicLink()) fail("contains a symbolic link");
  const files = [];
  function visit(directory) {
    for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
      // Express does not publish dotfiles. Never read them into build artifacts.
      if (item.name.startsWith(".")) { if (source) continue; fail("contains an unexpected hidden file"); }
      const file = path.join(directory, item.name);
      if (item.isSymbolicLink()) fail("contains a symbolic link");
      if (item.isDirectory()) visit(file);
      else if (item.isFile()) files.push(path.relative(root, file).split(path.sep).join("/"));
      else fail("contains an unsupported file type");
    }
  }
  visit(root);
  return files.sort();
}

function recipeFor(projectRoot = PROJECT_ROOT) {
  return Object.fromEntries(RECIPE_INPUTS.map(file => [file, digest(fs.readFileSync(path.join(projectRoot, file)))]));
}

function verifyFrontendBuild(projectRoot = PROJECT_ROOT) {
  const outputRoot = path.join(projectRoot, ".lpc-build"), frontendRoot = path.join(outputRoot, "frontend");
  if (fs.existsSync(outputRoot) && fs.lstatSync(outputRoot).isSymbolicLink()) fail("output directory is a symbolic link");
  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(path.join(outputRoot, "manifest.json"), "utf8")); }
  catch (_) { fail("is missing or unreadable"); }
  if (manifest?.owner !== BUILD_OWNER || manifest.version !== 1 || !Array.isArray(manifest.files)) fail("manifest is invalid");
  const recipe = recipeFor(projectRoot);
  if (JSON.stringify(Object.keys(manifest.recipe || {}).sort()) !== JSON.stringify(Object.keys(recipe).sort())
    || Object.entries(recipe).some(([file, hash]) => manifest.recipe[file] !== hash)) fail("recipe is out of date");
  const paths = manifest.files.map(file => file?.path);
  if (paths.some(file => typeof file !== "string" || !file || file.includes("\\") || file.includes("\0") || file.split("/").some(part => !part || part.startsWith(".")))
    || new Set(paths).size !== paths.length) fail("file inventory is invalid");
  let sources, outputs;
  try { sources = filesIn(path.join(projectRoot, "frontend"), { source: true }); outputs = filesIn(frontendRoot); }
  catch (_) { fail("file inventory is unavailable"); }
  if (JSON.stringify([...paths].sort()) !== JSON.stringify(sources) || JSON.stringify(sources) !== JSON.stringify(outputs)) fail("file inventory is out of date");
  for (const file of manifest.files) {
    if (!/^[a-f0-9]{64}$/.test(file.sourceHash || "") || !/^[a-f0-9]{64}$/.test(file.outputHash || "")) fail("file fingerprints are invalid");
    if (digest(fs.readFileSync(path.join(projectRoot, "frontend", file.path))) !== file.sourceHash) fail("source is out of date");
    if (digest(fs.readFileSync(path.join(frontendRoot, file.path))) !== file.outputHash) fail("output has changed");
  }
  return { frontendRoot, manifest };
}

function frontendDirectory({ projectRoot = PROJECT_ROOT, built = process.env.NODE_ENV === "production" || process.env.LPC_USE_BUILT_FRONTEND === "true" } = {}) {
  return built ? verifyFrontendBuild(projectRoot).frontendRoot : path.join(projectRoot, "frontend");
}

module.exports = { PROJECT_ROOT, BUILD_OWNER, RECIPE_INPUTS, digest, filesIn, recipeFor, verifyFrontendBuild, frontendDirectory };
