# LPC AI Operating Manual

Founder/operator manual for Samantha  
Codebase basis: current Let’s-ParaConnect admin dashboard, support system, marketing system, AI admin routes, and scheduler behavior in this repository.

## 1. Executive Overview

Let’s-ParaConnect currently has three distinct but connected operating layers:

1. The core admin dashboard: analytics, approvals, user management, payments, disputes, revenue, posts, logs, and settings.
2. The AI Control Room: an operational visibility and governed-decision layer that rolls up founder, marketing, support, admissions, lifecycle, payments/risk, sales, engineering, and incident signals. Informational items remain read-only; only explicitly action-backed decision items expose approve/reject controls.
3. The agent workflows behind the scenes: marketing planning and draft generation, support conversation assistance and escalation, founder daily summaries, monitoring, and a now-live Engineering / CTO workspace backed by incident-linked diagnosis and execution records.

What is live:

- The admin dashboard at `frontend/admin-dashboard.html`, including AI Control Room, Approvals, Knowledge, Marketing, Support, Engineering, Sales, user administration, payment/risk, activity, and settings surfaces.
- Governed Control Room decisions backed by existing approval routes. Informational, autonomous, and blocked items do not acquire invented action buttons.
- LinkedIn-only marketing planning, drafting, approval, connection validation, and explicit human-triggered publishing. Facebook remains retired and audit-only.
- In-product attorney and Paralegal support with grounded role-safe guidance, state-aware follow-ups, conversation-topic continuity, verified navigation, issue reopening, ticket/incident linkage, and bounded automatic milestone updates.
- Support Ops and Engineering workspaces with response packets, incident linkage, CTO diagnosis, execution planning, and explicit human decisions for sensitive actions.
- Approval, knowledge, and sales workflows that preserve review state and distinguish drafts from approved outbound use.
- A supervised incident worker plus five-minute automation and operations-monitor services; business schedulers do not run inside the horizontally scaled web process.
- Alerts sent to configured founder/owner recipients when governed incident or monitoring rules require them. Source-code fallback addresses are not production recipient evidence.

What is partial or planning-only:

- Facebook authoring and publishing are intentionally retired from the active product. Legacy Facebook briefs, packets, and cycle fields remain readable for audit history, but no new Facebook work can be created, reviewed, connected, or published.
- Standalone legacy AI-issue and CTO test routes are retired. Incident and Engineering are the only canonical operator workflows for technical-issue truth and planning.
- Fully autonomous engineering repair is only partial. There is a trusted local test path for specific low-risk incidents, but LPC should still be treated as approval-first for most real engineering work.

Overall architecture:

- Frontend: a single admin dashboard shell with section-based workspaces and separate JS modules for approvals, knowledge, marketing, support, sales, incidents, and AI Control Room behavior.
- Backend: Express routes split by pillar, backed by MongoDB models and service-layer orchestration.
- Persistence: MongoDB stores drafts, approvals, support tickets, founder logs, agent runs, incident data, and related records.
- Automation: Render runs the automation and operations-monitor services every five minutes. Operations checks and core lifecycle/deletion work run every cycle; due-slot marketing, director, monitoring-report, and founder-daily work is gated to its configured cadence inside the automation cycle.
- Safety posture: approval-first and manual-send/manual-publish by design. The system prepares decisions and drafts; it does not run the company autonomously.

## 2. Admin Dashboard and AI Control Room

### Major admin areas currently present

The current sidebar includes these sections:

- Overview
- AI Control Room
- Approvals
- Knowledge Studio
- Marketing Drafts
- Support Ops
- Engineering
- Sales Workspace
- User Management
- Photo Reviews
- Stripe
- Disputes
- Revenue
- Posts
- Activity Logs
- Settings

### Overview

This is the classic admin layer. It is not primarily AI-driven. It gives you:

- total users
- Stripe payment state
- active Matters
- pending approvals
- payout and income cards
- open disputes
- payment overview
- revenue reporting
- recent Matter posts
- admin activity logs

This is your platform operations home base, not your agent workspace.

### AI Control Room

This is the founder-facing operational visibility and governed-decision layer. A card is actionable only when it represents an implemented, authorized decision route; informational, autonomous, and blocked cards remain non-actionable and explain their state.

It currently shows:

- summary tiles for `Urgent`, `Awaiting Review`, `Risk`, and `Health`
- focus cards for marketing, sales, founder, admissions, support, payments/risk, incidents, and lifecycle
- a focused view panel for the selected operational lane
- queue sections for urgent queue, awaiting review, recent escalations, and outbound messages
- an incident workspace with incident list, detail, timeline, and repeated issue clusters

Important reality:

- This is a visibility and prioritization layer.
- It is not the same thing as an execution console.
- Incident timeline/detail views are read-only; governed decisions use their canonical approval or Engineering routes.

### Founder layer in Marketing Drafts

Inside the `Marketing Drafts` section, there is a distinct founder layer built for daily use.

It has three pieces:

1. Founder Daily Log
2. Quick Actions
3. Today’s Ready Posts

The Founder Daily Log does this:

- summarizes what matters today
- tells you what changed overnight
- tells you what needs you specifically
- lists blockers
- recommends next actions

Quick Actions do this:

- surface the next highest-value action without forcing you to scan the whole queue
- open packet detail
- approve a pending packet
- publish a ready LinkedIn company packet
- refresh the log
- jump into the full marketing queue

Today’s Ready Posts do this:

- show current LinkedIn company packet state
- show approval state
- show publish readiness
- show whether you can post now
- explain blockers truthfully

### Marketing area

The marketing workspace currently includes:

- publishing loop settings
- LinkedIn company connection and validation
- publishing cycles
- cycle detail
- Jr. CMO library
- ad hoc brief creation
- marketing packet queue
- packet detail with approved facts, message hierarchy, CTA options, founder notes, readiness, and publish history

This is the most complete AI-assisted operator flow in the current system.

### Engineering area

The Engineering workspace is now the founder-facing technical operations surface.

It currently includes:

- a top summary strip
- an engineering queue
- an item detail panel
- quick actions
- incident and support linkage
- CTO diagnosis visibility
- CTO execution packet visibility
- support-report recency signals so repeat user reports can move an existing engineering item back to the top of the queue
- latest support-chat report context, support report count, and last-reported timestamp inside item detail

Important reality:

- this is where support-linked engineering issues should be reviewed first
- it is founder-facing and operational, not a dev-only debug screen
- it is still approval-first for most real fixes and deployments

### AI Control Room functionality currently present

Currently present and live:

- founder rollups from routed founder alerts and lifecycle actions
- admissions completeness heuristics
- support queue rollups from tickets, incidents, FAQ candidates, and insights
- marketing queue rollups from actual marketing records
- sales workspace rollups from actual account/packet records
- payments/risk rollups from disputes plus money-sensitive incidents
- lifecycle rollups from routed actions plus some compatibility heuristics
- incident control room data from the incident system

Explicit boundaries:

- Engineering remains the canonical technical triage/execution workspace; Control Room cards link or decide but do not duplicate it
- broad autonomous fixing across the application
- autonomous deployment for general engineering work

## 3. Current C-Suite / Agent Inventory

Safety level language used in this manual:

- `Read-only`: visibility only
- `Assistive`: the system drafts or recommends, but a human still decides/sends
- `Approval-first`: content can be generated, but Samantha approval is required before use
- `Manual publish/send`: an action can happen in the product, but only when a human explicitly triggers it
- `Test-only`: available to admins/devs as a route or utility, but not part of the normal founder UI

### Jr. CMO

| Field | Current reality |
| --- | --- |
| Name | Jr. CMO |
| Purpose | Build daily marketing context, maintain a fact/opportunity library, and tee up what the CMO should talk about next |
| Inputs | Approved marketing knowledge, recent LinkedIn packet history, pending review count, internal signal ingestion, optional external research if enabled |
| Outputs | `MarketingDayContext`, `MarketingOpportunity`, `MarketingFact`, weekly evaluation summaries, cadence guidance, source references |
| Current safety level | `Approval-first` planning support |
| What it can do now | Refresh daily context, identify active opportunities, recommend tone, surface approved support facts, incorporate external research when enabled, feed the founder daily log and CMO planning |
| What it cannot do yet | Publish anything, approve anything, send anything, act as a full social manager, or independently decide final brand voice |

### CMO

| Field | Current reality |
| --- | --- |
| Name | Marketing CMO Agent |
| Purpose | Decide whether a scheduled marketing cycle should be created and pick the most supportable LinkedIn company topic/lane |
| Inputs | Jr. CMO briefing, approved marketing context, cadence history, pending review backlog, recent packet timing |
| Outputs | An agentic cycle plan used to create one governed LinkedIn company draft per publishing cycle |
| Current safety level | `Approval-first` |
| What it can do now | Hold when the queue is unhealthy, choose a topic lane, create a scheduled publishing cycle, and seed one LinkedIn company packet |
| What it cannot do yet | Bypass backlog rules, auto-publish, auto-approve, or force content into production without founder review |

### Founder Daily Log

| Field | Current reality |
| --- | --- |
| Name | Founder Daily Log |
| Purpose | Give you a daily founder-ready briefing of marketing state in practical language |
| Inputs | Marketing overview, publishing overview, Jr. CMO briefing, publish readiness, overnight changes, cycle creation state |
| Outputs | Daily summary, what changed, what needs Samantha, blockers, recommended actions, quick actions, ready-post cards |
| Current safety level | `Read-only` plus shortcut actions |
| What it can do now | Prepare a daily log, refresh on demand, generate quick actions, tell you whether LinkedIn is ready now, tell you exactly what is blocked |
| What it cannot do yet | Replace packet review, decide strategy for you, or publish without an explicit founder action |

### Support Agent

| Field | Current reality |
| --- | --- |
| Name | Support Agent / in-product support assistant |
| Purpose | Respond inside support conversations, gather grounded context, and escalate when needed |
| Inputs | User conversation text, page context, role/surface, Matter/application context, authorized workspace snapshots, payment/payout/messaging snapshots, and support policy state |
| Outputs | Assistant replies, internal summaries, category/urgency/confidence, support facts snapshot, automatic support ticket creation, and automatic incident creation/linking for engineering-worthy issues |
| Current safety level | `Assistive` for user chat, `Approval-first` escalation logic, `Manual send` for human team replies |
| What it can do now | Reply automatically inside the product, carry forward issue memory across turns, classify the issue, ground answers in visible facts, answer simple follow-up status questions without losing the thread, show state-aware welcome prompts for active vs recently resolved issues, vary status replies based on the real support/incident lifecycle, reopen previously resolved support-linked issues when the user says the problem came back, auto-route engineering-worthy reports into Support Ops plus Engineering, and trigger founder email alerts for support-linked engineering issues |
| What it cannot do yet | Reliably solve every bug by itself, send nuanced human support replies automatically in sensitive cases, or auto-close complex support cases without verified resolution |

### Monitoring Agent

| Field | Current reality |
| --- | --- |
| Name | Monitoring Agent |
| Purpose | Run lightweight health and trend checks on recent issue records |
| Inputs | Mongo connection state, AI status, recent `AgentIssue` records by category/urgency |
| Outputs | A monitoring report object with alerts and suggested actions; scheduler logs |
| Current safety level | `Read-only` internal heuristic monitoring |
| What it can do now | Flag repeated login/profile save/payment issue patterns and report system health |
| What it cannot do yet | Open a full founder-facing dashboard on its own, persist a dedicated monitoring queue, or replace the incident system |

### CTO Agent

| Field | Current reality |
| --- | --- |
| Name | CTO Agent |
| Purpose | Produce a first-pass technical diagnosis for a reported product issue |
| Inputs | A live Engineering incident and its governed category, urgency, message, route, role, and linked-support context |
| Outputs | Diagnosis summary, likely root causes, likely files to inspect, test plan, deployment risk, Codex patch prompt, and persisted `CtoAgentRun` records for the Engineering workspace |
| Current safety level | `Approval-first` engineering analysis |
| What it can do now | Diagnose likely issue areas, map likely frontend/backend files, auto-start diagnosis for support-linked engineering incidents, and surface a structured engineering brief in the live Engineering workspace |
| What it cannot do yet | Reliably confirm root cause in every case, replace engineering judgment, auto-deploy general fixes, or act as a fully autonomous repair system across the whole product |

### CTO Execution Pipeline

| Field | Current reality |
| --- | --- |
| Name | CTO Execution Pipeline |
| Purpose | Turn a CTO diagnosis into an implementation packet for engineering execution |
| Inputs | The persisted `CtoAgentRun` diagnosis attached to a canonical Engineering item |
| Outputs | Implementation summary, execution plan, patch artifact, required tests, deployment checklist, readiness assessment, user resolution draft, optional `CtoExecutionRun` |
| Current safety level | `Approval-first` planning support |
| What it can do now | Prepare a disciplined execution packet, persist `CtoExecutionRun` records, and feed the live Engineering workspace with implementation-ready context |
| What it cannot do yet | Reliably implement arbitrary code fixes on its own, deploy broad changes automatically, run migrations without review, or notify users without verified resolution |

## 4. Daily Founder Workflow

### What Samantha should check each morning

Start in this order:

1. `AI Control Room`
2. `Marketing Drafts` founder layer
3. `Engineering`
4. `Support Ops`
5. `Incident Workspace` inside the AI Control Room
6. `Approvals`

The reason for that order:

- AI Control Room tells you where the pressure is.
- Founder Daily Log tells you what marketing needs your approval or post action.
- Engineering tells you whether a user-reported product issue is only queued, actively diagnosed, blocked, ready for test, or resolved.
- Support Ops tells you whether support-owned users are blocked right now.
- Incident Workspace tells you whether there is a broader technical pattern behind those support and engineering signals.
- Approvals is where you cleanly clear governed review work.

### How to use the Founder Daily Log

Treat it as your morning briefing, not as a substitute for packet review.

Use it to answer:

- Did anything meaningful happen overnight?
- Is anything ready for me to approve?
- Is anything ready for me to post?
- Is LinkedIn actually connected and validated?
- What is blocked, and why?

Operationally:

- If it says a post is `Ready to post`, you can manually post the approved LinkedIn company packet from the founder layer.
- If it says `Ready to review`, open the packet and review/approve it.
- If it says `Blocked`, read the blocker literally. It is intended to reflect actual readiness, not optimism.

### How to use Quick Actions

Use Quick Actions when you want the next action immediately instead of browsing.

Typical valid uses:

- `Review Draft`
- `Approve Pending Packet`
- `Post Now`
- `Open full marketing queue`
- `Refresh daily log`

If you need nuance, open the packet detail before acting.

### How to review marketing drafts

Check:

- packet summary
- approved fact cards used
- positioning blocks used
- claims to avoid
- channel draft body
- founder voice notes
- what still needs Samantha
- publish readiness

Approve only when:

- the draft is accurate
- the facts used are supportable
- the tone matches current LPC positioning
- the CTA is appropriate
- there are no unresolved blockers you care about

### How to handle urgent support issues

Go to `Support Ops` and review:

- open blockers
- account-access tickets
- money-sensitive tickets
- any support-owned tickets still waiting for human reply

Then separately check `Engineering` for:

- newly created incident-backed issues
- auto-started CTO diagnosis
- issues marked `Blocked`, `Ready for Test`, or `Resolved`

Then:

1. open the ticket detail
2. review the latest support facts snapshot
3. review the recommended response packet
4. add an internal note if needed
5. send a team reply manually if you are ready
6. move the ticket status intentionally

The system can draft, classify, and auto-route. It does not remove the need for human judgment on sensitive replies.

### How to review technical incidents

Use the `Engineering` section first, then the `Incident Workspace` if you need broader timeline detail.

Review:

- engineering summary strip
- queue status
- diagnosis and execution packet detail
- incident/source linkage
- quick actions and current stage
- then incident timeline and repeated clusters if you need wider operational context

Then decide:

- Is this just one user’s support issue?
- Is it a broader incident?
- Does it touch money, authentication, authorization, or Matter progress?

Important:

- The Incident system is the canonical ops system.
- The Engineering section is now the main founder-facing workspace for technical items.
- The AI Control Room still gives summary visibility, but Engineering is where you inspect current diagnosis/execution state.

## 5. Marketing Workflow

### How Jr. CMO and CMO work together

The current logic is:

1. Jr. CMO refreshes daily context and active opportunities.
2. Jr. CMO maintains the fact/opportunity library and cadence context.
3. CMO checks whether new drafting should happen at all.
4. CMO refuses to generate more work if Samantha already has pending packets.
5. CMO chooses the strongest supported next lane/topic.
6. A publishing cycle is created only when the queue state is healthy enough.

In plain English:

- Jr. CMO prepares the thinking.
- CMO decides whether it is actually time to create work.

### How packets get created

There are two ways packets are created now:

1. Ad hoc brief creation from the Marketing Drafts UI
2. Scheduled or manual publishing cycle creation

Ad hoc briefs currently support:

- `founder_linkedin_post`
- `platform_update_announcement`

Publishing cycles currently generate one active workflow:

- `linkedin_company_post`

The historical `facebook_page_post` enum remains only so older stored records can be read. It is excluded from new brief creation, cycle creation, active approval queues, connection management, and publishing.

### How review/publish readiness works

Current sequence:

1. Brief exists
2. Draft packet exists
3. Samantha reviews packet
4. Packet is approved or rejected
5. Publish readiness is checked separately
6. Only then can LinkedIn company publishing happen

Approval does not equal publishing.

Readiness for LinkedIn company checks:

- packet is the LinkedIn company workflow
- packet is approved
- LinkedIn connection is `connected_validated`
- publish text exists
- publish text is within length limits
- there is no in-flight publish
- the packet has not already been published

### What “approval-first” means here

In LPC’s current system, approval-first means:

- the agent can draft
- the agent can recommend
- the agent can schedule a cycle
- the founder still approves before external use
- publish is a separate explicit action

This is deliberate. The system is optimized for governed output, not autonomous brand publishing.

### Current channel status

LinkedIn company:

- live connection flow exists
- OAuth flow exists
- authorization validation exists
- readiness checks exist
- manual publish-now exists for approved packets

Facebook page:

- is not an active LPC workflow
- cannot create new briefs, packets, approval work, connections, or publish attempts
- may appear only in legacy stored history, labelled as retired and read-only

So today LinkedIn company is the only operational company publishing channel, with governed manual publishing.

## 6. Support / Technical Incident Workflow

### How user issues enter the system

There are two real entry paths today:

1. In-product support conversations via `/api/support/conversation`
2. Manual or admin-created support tickets via `/api/admin/support/tickets`

For founder operations, the important live path is the first one.

Users can:

- open a support conversation
- send messages
- get assistant help

If the support assistant determines the user is describing a real product issue, the system now auto-routes it:

- a `SupportTicket` is created or updated
- the ticket is linked to an existing open incident or a new incident is created
- the issue appears in `Engineering`
- CTO diagnosis starts automatically when appropriate
- configured founder-alert recipients receive an email; production recipients must be verified from configuration rather than inferred from a source-code fallback

The user does not need to understand the internal routing model. The system is supposed to figure out whether this is normal support or an engineering issue.

### How Support Agent triages

The Support Agent currently does this:

- classifies the issue
- estimates urgency/confidence
- gathers page and entity context
- compiles support facts
- builds an assistant reply
- decides whether the issue should remain support-owned or become an engineering incident
- keeps follow-up questions anchored to the same issue when the thread is already in engineering review
- can reopen an existing open-issue thread through a welcome prompt without making the user restate the entire issue from scratch

When the issue is engineering-worthy:

- a support ticket is created automatically
- the ticket is linked to an existing incident or a new incident is created
- a handoff summary is generated
- the conversation records the escalation state
- founder email notification is sent on issue-created and again on issue-fixed

### How CTO diagnoses

Current reality:

- diagnosis runs through the live canonical Engineering workflow
- support-linked engineering incidents can auto-start CTO diagnosis
- the resulting packet is saved as a `CtoAgentRun` and shown in Engineering item detail

This means “sent to engineering” now means more than just “a ticket exists.” It means the issue can immediately enter technical diagnosis without you manually clicking an escalation step.

### How CTO Execution prepares implementation

CTO execution is the second stage:

- it takes a diagnosis or `CtoAgentRun`
- it builds an execution packet
- it defines likely files, likely change types, tests, constraints, readiness, and a user-facing resolution draft
- it can optionally persist a `CtoExecutionRun`

Again, this is planning support, not automatic engineering.

### What still requires manual approval

Still manual today:

- approving marketing packets
- publishing LinkedIn posts
- admin support replies
- support status decisions
- many incident decisions
- most real engineering fixes
- most deployments
- most user notifications that imply a real resolution

### When users can be notified

Support users can be notified when:

- a human sends a team reply from Support Ops
- a support ticket is actually resolved and that resolution is stable

Founder notifications now also exist for support-linked engineering issues:

- configured founder-alert recipients receive an email when a support chat issue becomes an engineering incident
- configured founder-alert recipients receive a second email when that support-linked issue reaches fixed/resolved status

For user-facing communication:

- the support chat thread itself is the primary user-facing channel for support-linked issues
- LPC intentionally keeps extra user notifications minimal for support chat submissions
- redundant “sent to the team” notifications should not be treated as the main communication pattern
- restarting a support conversation should clear the old thread in one action and open a fresh support thread with a new welcome state
- when a user reopens support, the welcome prompt should reflect the actual issue state:
  - active issue: `You still have an open [issue].`
  - recently resolved issue: `Your [issue] has been resolved.`
- those proactive prompts now carry structured support intent, so LPC can answer status checks based on issue state instead of depending only on the literal button text
- when a user asks for an update on a support-linked issue, LPC should now answer from the actual lifecycle state instead of using one generic status reply:
  - support-owned and still open: still open with the team
  - linked to Engineering and actively being worked: already with engineering
  - fix in verification: being tested now
  - fixed live: has been resolved
  - closed out after review: closed out, with reopen language if it comes back
- if a user says a resolved issue is still happening again, LPC should now actually reopen that same support ticket, move it back to active review, and return it to engineering if it is an engineering-linked problem
- if a user says a resolved issue came back and asks a second simple LPC question in the same message, LPC should now reopen the issue first and still answer the simple navigation/guidance follow-up in that same reply
- for support-linked engineering issues, LPC can now also post a short automatic support-thread update at meaningful milestones instead of keeping that progress entirely hidden:
  - final review
  - fix live / resolved
  - closed after review
- if a user asks when something will be fixed, the chat should acknowledge that the issue is already with engineering and avoid inventing a fake ETA
- if a user asks for an issue update and a second simple LPC navigation question in the same message, LPC should now answer the issue-status part first and still handle the second part in the same reply
- if a user asks for an issue update and a second simple LPC guidance question in the same message, LPC should now answer the issue-status part first and still answer the guidance follow-up instead of forcing a second conversation turn
- if a user pivots from one topic into a broader LPC guidance question, the chat should now reset to the new topic instead of dragging the old issue context forward
- if a user asks a broad `what should I do next?` follow-up, LPC should try to answer from the active topic first before asking for more detail
- if a user asks one message that contains two related support needs, LPC should try to answer both in one grounded reply before asking them to split the question apart
- if LPC gives a combined answer, it should also be able to surface branch suggestions like `Stripe` or `Messages` so the user can keep the thread moving without typing a perfect follow-up
- if a user asks one message that contains two unrelated support needs, LPC should now split that into a short topic-choice prompt and remember those options for the next turn
- if LPC offers a short topic-choice prompt and the user says `both` or `all of them`, LPC can now answer those selected topics in one reply instead of forcing the user to choose only one branch
- once LPC offers topic choices, it should honor natural follow-ups like `payments first`, `messages first`, `the second one`, or `the other one` instead of making the user restate the whole question
- if a user corrects themselves mid-thread with phrases like `no, I mean...`, `actually...`, or `specifically...`, LPC should now treat that as a real course correction instead of falling back to intake or stale context
- if a user is clearly frustrated but also vague, the clarification should stay human and service-oriented rather than sounding like a bug form
- when a support-linked engineering incident is actually fixed and verified, the linked support ticket should close automatically so it stops appearing as open founder work
- Support Ops also reconciles stale engineering handoffs on load so an already-fixed incident should not keep inflating current open-ticket counts
- the execution packet can draft a user-facing resolution message
- LPC should still only tell the user the issue is fixed after the issue is actually fixed and verified

## 7. Key Models / Records

### `AgentIssue`

Plain English purpose:

- a lightweight issue record for AI/support/technical problem reporting
- used by the Monitoring Agent and CTO diagnosis pipeline

Important caveat:

- this is now more of a legacy technical issue store
- the new Incident system is treated as the canonical operational incident source

### `FounderDailyLog`

Plain English purpose:

- the saved daily founder marketing briefing for a given date in `America/New_York`

It stores:

- summary
- what changed
- what needs Samantha
- blockers
- recommended actions
- quick actions
- ready-post cards
- compact status counts
- generation metadata

### `CtoAgentRun`

Plain English purpose:

- a saved technical diagnosis packet

It stores:

- category
- urgency
- technical severity
- diagnosis summary
- likely root causes
- affected areas
- files to inspect
- test plan
- deployment risk
- Codex patch prompt
- approval posture

### `CtoExecutionRun`

Plain English purpose:

- a saved execution-planning packet based on a CTO diagnosis

It stores:

- execution status
- implementation summary
- execution plan
- patch artifact
- required tests
- deployment checklist
- readiness status
- user resolution draft
- approval posture

## 8. Key Admin Operator Routes

### Founder/operator routes already backing the dashboard

| Route | Current use |
| --- | --- |
| `/api/admin/ai/control-room/summary` | Main AI Control Room summary rollup |
| `/api/admin/ai/control-room/founder` | Founder Copilot focus view |
| `/api/admin/ai/control-room/marketing` | Marketing focus view |
| `/api/admin/ai/control-room/support` | Support focus view |
| `/api/admin/ai/control-room/admissions` | Admissions focus view |
| `/api/admin/ai/control-room/payments-risk` | Payments/risk focus view |
| `/api/admin/ai/control-room/lifecycle` | Lifecycle focus view |
| `/api/admin/ai/control-room/incidents` | Incident Control Room focus view |
| `/api/admin/marketing/founder-daily-log` | Load founder daily log |
| `/api/admin/marketing/founder-daily-log/refresh` | Regenerate founder daily log |
| `/api/admin/marketing/jr-cmo/library` | Load Jr. CMO library |
| `/api/admin/marketing/publishing/overview` | Marketing publishing loop overview |
| `/api/admin/marketing/draft-packets/:id/publish-readiness` | Check whether a packet can actually be published |
| `/api/admin/marketing/draft-packets/:id/publish-now` | Manually publish an approved LinkedIn company packet |
| `/api/admin/support/overview` | Support Ops summary |
| `/api/admin/support/tickets` | Support ticket list/create |
| `/api/admin/support/tickets/:id/reply` | Manual team reply to a support ticket |
| `/api/admin/engineering/overview` | Engineering summary strip and queue metrics |
| `/api/admin/engineering/items` | Engineering queue list |
| `/api/admin/engineering/items/:id` | Engineering item detail |
| `/api/admin/engineering/items/:id/diagnose` | Run or re-run CTO diagnosis for an engineering item |
| `/api/admin/engineering/items/:id/execution` | Build an execution packet for an engineering item |

Diagnosis, execution planning, and resolution are available only through the canonical `/api/admin/engineering/items/:id/*` workflow. Standalone test and legacy issue routes were retired before launch.

### Practical note

If you are operating the company day to day, use the dashboard sections and their Engineering actions. The routes above are the implementation contract behind those actions, not a parallel operator workflow.

## 9. What Is Automated vs Manual

### Automated now

- AI Control Room summaries and focus views
- operations monitoring every five minutes, with cadence-specific automation work running only when its due slot is reached
- scheduled Jr. CMO refresh
- scheduled marketing due-slot checks
- founder daily log prep after 9:00 AM Eastern
- support conversation replies inside the in-product support flow
- support issue classification
- support ticket creation for escalated support conversations
- support-to-engineering incident routing for engineering-worthy user chat issues
- automatic CTO diagnosis kickoff for support-linked engineering incidents
- support response packet generation
- founder email alert when a support chat issue becomes an engineering incident
- founder email alert when a support-linked engineering incident is fixed
- marketing packet generation from briefs/cycles
- LinkedIn readiness checks
- approval task creation for governed items
- limited autonomous incident repair for specific trusted low-risk test paths

### Manual now

- final packet approval
- rejection decisions
- LinkedIn post publishing trigger
- support team replies
- support ticket resolution decisions
- many technical diagnosis decisions
- many execution packet decisions
- most actual code fixes
- most actual deployments
- final user notification on resolved issues in the general case

### The simplest way to think about it

The system is currently strongest at:

- preparing
- summarizing
- drafting
- routing
- prioritizing

It is intentionally conservative about:

- publishing
- sending
- resolving
- deploying

## 10. Known Gaps / Not Yet Implemented

Be explicit about these:

- Facebook is intentionally outside the active authoring and publishing scope; only legacy audit history is retained.
- The legacy AI Monitoring Agent is lightweight and heuristic. Production health, backup, payment, file, archive, and deletion monitoring is a separate supervised service with durable alert-suppression state; neither replaces provider dashboards or incident review.
- Lifecycle rollups still include some compatibility heuristics while migration continues.
- Support can draft and route well, but complex user communication still depends on human handling.
- The Engineering workspace is live, but the AI Control Room still does not function as the engineering execution console.
- The system can auto-start diagnosis, but broad autonomous bug fixing is still limited and should not be assumed across the app.
- The system does not broadly auto-deploy arbitrary fixes.
- The system sends configured founder alerts for governed support-linked engineering milestones, but not every internal state change should become an email.
- The founder layer is concentrated in marketing; there is not yet an equally mature founder action layer for every pillar.

## 11. Recommended Next Steps

Before launch, prioritize evidence and operational readiness over expanding autonomy:

1. Prove all four Render services run the same approved commit and retain the production-verification artifact.
2. Validate alert delivery/recovery, Atlas restore, Stripe reconciliation, malware controls, and the four-service rollback runbook.
3. Keep Support Ops, Engineering, Incident, and Control Room ownership explicit so a record has one canonical action surface.
4. Expand autonomous repair only through reviewed safe recipes, bounded permissions, deterministic verification, and an auditable rollback path.
5. Notify users of resolution only after the authoritative incident/support state proves the fix is deployed and verified.
6. Retire compatibility-only data and navigation paths only through measured migrations that preserve existing deep links and audit history.

## Bottom Line

LPC already has a meaningful founder-operable AI operating layer, but it is not an autonomous company-running system.

Today, the strongest production-ready pattern is:

- AI prepares context
- AI drafts governed work
- AI surfaces the next decision
- Samantha approves, publishes, replies, or escalates

That is the real current operating model.
