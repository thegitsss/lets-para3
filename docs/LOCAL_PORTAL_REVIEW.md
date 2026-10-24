# One local portal review address

Both portals use the main working checkout at `/Users/samanthasider/Desktop/lets-para3` and the existing backend on **http://localhost:5050**.

- Attorney: http://localhost:5050/attorney-v2.html
- Paralegal: http://localhost:5050/paralegal-v2.html
- Port 5051's visual preview is retired. Do not restart it as a competing review version.

Isolated branches may still be used to prepare changes. Before showing approved changes locally, reconcile their exact delta against the current main working files. Preserve newer uncommitted work; never replace whole files or copy an old build over the working source. Resolve overlapping files with their current owner before publishing the local result. Keep backend contracts and role permissions intact.

After reconciliation, build the frontend with the repository's pinned Node version, run affected-area checks for both roles, and verify that 5050 serves the expected bytes. A source build or a branch name alone does not establish what the browser is receiving. Check the served assets and inspect rendered pages.

Current reconciliation evidence and the pre-check frontend backup are in `outputs/lpc-local-consolidation-20261016/`. This local arrangement does not authorize a push, release-branch merge, deployment, or rollout.

The backend's `nodemon.json` excludes tests, generated browser reports, coverage, and build outputs. Keep one `npm run dev` watcher for 5050; duplicate watchers and watched test artifacts can cause interruptions during review. Source changes to backend application code still restart the server normally.
