import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { parse } from "@babel/parser";
import traverse from "@babel/traverse";

const scriptPath = fileURLToPath(import.meta.url);
const scriptDirectory = path.dirname(scriptPath);
const repositoryRoot = path.resolve(scriptDirectory, "../..");
const scriptsRoot = path.join(repositoryRoot, "frontend", "assets", "scripts");

function walk(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(directory, entry.name);
    return entry.isDirectory() ? walk(target) : [target];
  });
}

function isExportedBinding(bindingPath) {
  let cursor = bindingPath;
  while (cursor && !cursor.isProgram()) {
    if (cursor.isExportNamedDeclaration() || cursor.isExportDefaultDeclaration()) return true;
    cursor = cursor.parentPath;
  }
  return false;
}

function parseSource(source, filePath) {
  return parse(String(source), {
    sourceFilename: filePath,
    sourceType: "unambiguous",
  });
}

function findUnusedBindings(source, filePath = "frontend-script.js") {
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

function checkFrontendBindings(root = scriptsRoot) {
  const scriptFiles = walk(root).filter((filePath) => filePath.endsWith(".js")).sort();
  const issues = [];
  for (const filePath of scriptFiles) {
    const source = fs.readFileSync(filePath, "utf8");
    let unused;
    let unmarkedUnusedParameters;
    let silentAwaitCatches;
    try {
      unused = findUnusedBindings(source, filePath);
      unmarkedUnusedParameters = findUnmarkedUnusedParameters(source, filePath);
      silentAwaitCatches = findSilentAwaitCatches(source, filePath);
    } catch (error) {
      issues.push({
        filePath,
        line: error?.loc?.line || 1,
        message: `could not parse: ${error.message}`,
      });
      continue;
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
  return { scriptFiles, issues };
}

function runRepositoryCheck() {
  const { scriptFiles, issues } = checkFrontendBindings();
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
    `[frontend-bindings] ${scriptFiles.length} scripts contain no unused bindings or silent awaited catches.`
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
  isExportedBinding,
};
