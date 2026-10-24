# Local development configuration

Run commands with Node 24.18.x from `backend`, using `npm run dev` for the web
server. The web server, communications worker, incident runner, automation,
monitor, and backup now load the same backend `.env` regardless of the shell's
working directory. Explicit process environment variables take precedence.
Tests do not load workstation secrets.

`npm run check:local-config` inspects configuration and local process presence
without connecting to MongoDB, sending email, importing mail, or calling cloud
providers. It exits nonzero for configuration failures. Process detection does
not establish worker health, and a cron process need not be running between
scheduled jobs. `/api/health` reports database connectivity only.

For port 5050, use:

```dotenv
EMAIL_BASE_URL=http://localhost:5050
OPS_HEALTHCHECK_URL=http://localhost:5050/api/health
```

Preserve the existing provider-registered `LINKEDIN_OAUTH_REDIRECT_URI`.
A callback on a different origin from localhost is not, by itself, a defect.
Do not replace a working provider callback merely to match the local port.
Changing an OAuth callback requires checking the registered URI and full flow;
local configuration alone does not prove registration or OAuth success.
The Google, Stripe, and profile settings are independent of these corrections.

After `node scripts/setup-support-mailbox.cjs` verifies the support account and
intake folder, development processes automatically load its owner-only saved
connection. The saved file is never loaded in tests, production, or hosted
Render/staging processes. Explicit settings for a different account prevent
fallback so accounts and tokens cannot be mixed. Hosted services still need
their own environment variables. Restart a process after environment changes.

Background services retain their existing commands:

| Service | Command | Scheduling |
| --- | --- | --- |
| Communications | `npm run admin:communications` | Long-running |
| Incidents | `npm run incident:runner` | Long-running |
| Automation | `npm run automation:cycle` | Each five minutes |
| Monitor | `npm run ops:monitor` | Each five minutes |
| Local backup | `npm run backup:db` | According to approved backup policy |

These commands can send real messages, import mail, change database records,
remove expired files, or execute scheduled work. Do not attach them to `dev`
when localhost points at a remote/shared database with live provider credentials.
Use isolated development data and provider targets before running the full
service set. Production uses the separate services in `render.yaml` and the
production operations runbook.

Backup and monitor paths resolve relative to `backend`, including when invoked
from the repository root. A missing status record remains a failure until an
actual backup succeeds; creating an empty file does not repair it. Private local
backup archives are separate from Atlas snapshot monitoring and restore proof.
