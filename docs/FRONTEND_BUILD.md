# Frontend production build

Run `npm ci --include=dev` in `backend` to install the pinned build tools, then `npm run build:frontend`. The generated `.lpc-build/frontend` directory contains the assets served in production; its manifest stays outside the public directory. Both generated and temporary build directories are ignored by Git.

The build keeps all public asset paths. It copies HTML, fonts, images and other non-code assets byte-for-byte and prints JavaScript using pinned Terser with compression and name mangling disabled. CSS is serialized with pinned clean-css at level 0; optimization, import inlining and URL rebasing are disabled. This reduces formatting whitespace while preserving rule order, selectors, values and asset paths. Babel identifies script and module syntax, including top-level await. License comments are retained. See the [Terser API options](https://terser.org/docs/api-reference/) for the tool settings; the repository tests independently compare generated syntax and execute sample output.

Every output is associated with its current source hash. Startup also verifies the complete file inventory, output hashes, build implementation and dependency graph. A missing, stale or damaged build stops production startup with a rebuild instruction. Failed generation preserves a previously owned output directory. The builder refuses to overwrite an unrelated directory or follow asset symlinks; hidden source files are not published.

`npm start` uses the verified build. Normal `npm run dev` uses editable source. To exercise generated assets through the local application, build first and run `LPC_USE_BUILT_FRONTEND=true npm run dev`. Rebuild after changing frontend source, build code or the dependency graph.

`npm run check:performance` builds and checks the actual generated asset directory against the existing 7 MiB total and per-file budgets. Source hygiene and binding checks still inspect readable source. `npm run test:playwright:performance` also builds before serving the generated files for its public-page lab checks. Those lab results do not establish real-user p75 or physical-device acceptance.

The prepared web-service Blueprint installs build dependencies and generates assets during its build phase. Production deployment, compiled role workflows, provider behavior and field performance still need their release evidence. Retained design previews are available through the separate [local preview mode](design-previews/retained-2026-09-08/README.md).
