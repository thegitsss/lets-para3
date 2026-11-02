# Integrate the four features into the existing Mac app on 5051

User scope: document preparation/submission review (including OCR), native DOCX collaboration, Clio connection/transfers, and matching by work. Preserve the current local interface. No historical gold/cream palette, serif UI headings, enclosing cards, global restyling, production deployment, or unrelated cleanup.

The local app is newer than this review branch. Browser inspection of localhost:5051 confirmed its system-font UI and existing portal-header.css, matter-surface.css, context-ai.css, home-quick-reply.css, and other newer local styles. Do not replace its checkout or copy whole older HTML/app/view modules over it.

1. Locate the actual process listening on 5051 and its repository directory. Inspect its current branch, working changes and AGENTS.md before edits; preserve all existing work.
2. Fetch codex/lpc-connected-workspace from thegitsss/lets-para3. Use the final diff against d6ec22429b519f4e0ded371fee6322b4b9bca6e7 as a reference and apply only feature-specific additions. Do not cherry-pick historical visual commits or switch the serving repository wholesale to this branch.
3. Add the connectedWorkspace backend services, models, routers and tested lifecycle hooks; merge the four router mounts and exact provider CSP origin into current index.js. Keep current auth, money authority, account and file-write controls. Add the Textract dependency using the project's prescribed npm version without downgrading current dependencies.
4. Merge native feature imports/mounts into the CURRENT attorney Work/Files/directory/Connections and paralegal Work/Files implementations. Add new scoped assets and preserve every current HTML stylesheet/script link and existing feature. Use current local portal tokens, typography and row layouts. No global font/color/avatar replacement. Keep Clio's official symbol/wordmark.
5. Run focused feature and native UI checks appropriate to the merged code. Restart only the identified local development process if necessary, on the existing 5051 port, and verify both actual role shells and the four feature entry points there.
6. Missing Clio/ONLYOFFICE/AI/OCR configuration must show truthful availability; never insert runtime fixtures or claim live-provider verification from simulated tests. Do not deploy, merge to main, touch production configuration, or purchase services.
7. Report the local repository/branch/commit, changed files, check results and actual 5051 URLs. Do not report completion merely because GitHub or a separate cloud preview was updated.
