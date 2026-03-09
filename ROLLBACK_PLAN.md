# Rollback Plan (Render Auto‑Deploy)

## Goal
Restore a stable release within 4 hours of detecting a production issue.

## Preconditions
- Access to Render dashboard (web service + Events).
- Current production is the latest successful auto‑deploy from `main`.
- Previous known‑good is the immediately previous successful deploy in Render Events.
- On‑call contact list and status page access available.

## Steps (Render)
1. **Identify target rollback deploy**
   - Open Render Dashboard → Web Service → **Events**.
   - Note **current production**: latest successful auto‑deploy from `main`.
   - Select **previous known‑good**: immediately previous successful deploy in Events.
   - Record:
     - Current deploy ID: `__________`
     - Target rollback deploy ID: `__________`

2. **Pause risky actions (if needed)**
   - Pause any background jobs that mutate data (if applicable).
   - Announce a brief maintenance window.
   - Disable new case creation if needed (feature flag).

3. **Rollback via Render**
   - In **Events**, click **Rollback** on the target deploy.
   - Wait for deploy status to turn **Live** and **Successful**.

4. **Validate (15 minutes)**
   - Confirm `/api/health` returns `ok: true`.
   - Log in as attorney + paralegal and confirm dashboards load.
   - Open `case-detail.html` and ensure messaging loads.
   - Create a test case post (if allowed) and verify it appears in listings.

5. **Communicate**
   - Notify internal stakeholders that rollback is complete.
   - Post a status update for users if there was downtime.
   - Create a follow‑up ticket to root‑cause the incident.

## Manual Deploy (Specific Commit)
- Render Dashboard → Web Service → **Manual Deploy** → **Deploy a specific commit**.
- Enter the desired commit SHA from `main`.
- Wait for the deploy to go **Live** and **Successful**.

## Rollback Drill (Tabletop)
- Date: `March 9, 2026`
- Operator: `Samantha Sider`
- Current deploy ID: `9001f60`
- Target rollback deploy ID: `981ff12`
- Duration (start → verified): `5 minutes`
- Result: `PASS`
- Notes: `Tabletop drill only; no actual rollback executed.`

## Notes
- Keep a copy of the failing logs to diagnose root cause after rollback.
