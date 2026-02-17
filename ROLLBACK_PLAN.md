# Rollback Plan (Draft)

## Goal
Restore a stable release within 4 hours of detecting a production issue.

## Preconditions
- Current production version/tag/commit is known.
- Previous stable version/tag/commit is known.
- Access to deploy pipeline or server is available.

## Steps
1. **Identify target rollback version**
   - Record current version: `__________`
   - Select previous stable version: `__________`

2. **Pause risky actions**
   - Pause any background jobs that mutate data (if applicable).
   - Announce a brief maintenance window.

3. **Deploy rollback**
   - Deploy previous stable build/commit.
   - If using a container registry, pull and deploy the last known good image.

4. **Validate**
   - Confirm `/api/health` returns `ok: true`.
   - Log in as attorney + paralegal and confirm dashboard loads.
   - Open `case-detail.html` and ensure messaging loads.

5. **Communicate**
   - Notify internal stakeholders that rollback is complete.
   - Post a status update for users if there was downtime.

## Notes
- Keep a copy of the failing logs to diagnose root cause after rollback.
