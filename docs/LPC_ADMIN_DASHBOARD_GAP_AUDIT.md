# LPC Admin Dashboard Gap Audit

Founder/operator audit for Samantha  
Scope: current admin dashboard, War Room / AI Control Room, marketing founder layer, support ops, incident visibility, and CTO-related tooling.

## Purpose

This is the short version of where the admin dashboard stands today:

- what is already strong
- what is missing
- what should be fixed first
- what can wait

The priorities below are based on current code and current operator reality, not on aspirational product ideas.

## Executive Read

The dashboard is already strong as:

- a founder visibility layer
- a governed marketing operating system
- a support triage and review workspace
- a unified approvals workspace

The biggest gap is that engineering/technical operations are only partially represented:

- incidents are visible
- support escalations are visible
- CTO planning routes exist
- but there is no true engineering workspace in the dashboard yet

That is the single biggest structural hole.

---

## Must Fix

These are the gaps that most directly affect founder operations and operational clarity.

### 1. Build a real Engineering / CTO workspace

Current state:

- The AI Control Room shows engineering as unavailable.
- CTO diagnosis and CTO execution exist only as admin/test routes.
- There is no dashboard-native place to review `CtoAgentRun` and `CtoExecutionRun` records.

Why this is a must fix:

- Technical incidents are already a real operating concern.
- Support and incident visibility exist, but the next step into engineering action does not.
- This creates a handoff gap exactly where the highest-risk issues need the cleanest workflow.

What this workspace should include:

- queue of technical incidents needing engineering review
- CTO diagnosis output
- CTO execution output
- linked source records from support tickets and incidents
- status model from diagnosis to implementation to verification
- explicit manual approval and deployment posture

### 2. Make support, incidents, and engineering feel like one system

Current state:

- Support Ops is live.
- Incident Workspace is live and read-only.
- CTO routes are separate.

Why this is a must fix:

- Samantha should not have to mentally stitch together whether a user complaint, support ticket, incident, and technical fix are all the same issue.
- The system is operationally strongest when one problem has one obvious path.

What should happen:

- support ticket detail should clearly show linked incident state
- incident detail should clearly show linked support/user impact
- engineering workspace should open from both
- founder-facing status should roll up from one shared truth

### 3. Add a founder action layer for support and incidents

Current state:

- Marketing has a strong founder layer.
- Support and incidents do not.

Why this is a must fix:

- Right now the marketing workflow is founder-friendly in a way support and engineering are not.
- During a real issue, Samantha needs “what do I do next” as much as “what exists.”

What this should include:

- top urgent support issues
- top urgent incidents
- suggested next action
- whether user communication is safe yet
- whether engineering is already engaged
- blocker reason in plain English

### 4. Remove ambiguity around what is live vs partial vs test-only

Current state:

- The dashboard generally works, but some surfaces are live while others are placeholders or test utilities.
- That maturity difference is not always explicit enough.

Why this is a must fix:

- Founder trust depends on knowing whether a panel is operational, read-only, assisted, or not truly wired yet.

What should be clearer in UI copy/state:

- live operational
- read-only visibility
- approval-first draft system
- blocked/not implemented
- internal test utility

---

## Should Fix

These are meaningful improvements that would materially sharpen the product, but they are not the first operational blockers.

### 5. Add a real monitoring surface

Current state:

- Monitoring runs on the scheduler.
- It generates report objects and logs.
- It does not have a first-class dashboard queue or historical review view.

Why it matters:

- Pattern buildup can be easy to miss if it only shows indirectly through other views.

What should exist:

- recent monitoring runs
- repeated issue spikes
- new alerts since yesterday
- trend history by category
- “needs founder attention” thresholding

### 6. Decide whether Facebook is real or deferred

Current state:

- Facebook packets are created and reviewed.
- Facebook publishing is blocked.

Why it matters:

- The workflow currently asks for review attention on a channel that is not truly executable yet.

Decision needed:

- either finish Facebook execution
- or clearly move Facebook into a later phase so it stops creating operator noise

### 7. Simplify marketing state language

Current state:

- Marketing is functionally strong.
- But the founder still has to understand the difference between cycle state, packet approval state, and publish readiness.

Why it matters:

- The underlying logic is correct.
- The operator model can still be simpler.

What to tighten:

- one founder summary sentence per channel
- one “safe next action” state
- one blocker sentence

### 8. Reduce compatibility-only legacy surfaces

Current state:

- The Incident system is canonical.
- Some legacy AI issue paths and compatibility logic still exist.

Why it matters:

- Canonical truth should feel obvious.
- Legacy compatibility should not compete with current ops thinking.

What to do:

- continue keeping legacy routes internal only
- mark them clearly as non-canonical
- prefer incident-linked workflows everywhere founder-facing

---

## Nice To Have

These would improve polish, speed, and operator comfort, but they are not the highest-leverage fixes first.

### 9. Add historical founder snapshots

Useful additions:

- yesterday vs today founder view
- daily delta in approvals, disputes, support blockers
- trend memory for founder decisions

### 10. Add cross-workspace quick links everywhere

Examples:

- from support ticket to incident
- from incident to linked support tickets
- from founder alert to source record
- from lifecycle follow-up to relevant user/account record

### 11. Add stronger operator-level filters and saved views

Examples:

- “money risk only”
- “account access blockers”
- “founder action needed today”
- “marketing ready to post”
- “support waiting on team”

### 12. Add more explicit status legends

Useful for:

- newer team members
- fast interpretation under pressure
- reducing ambiguity in badge colors and state names

---

## Details That Still Need To Be Ironed Out

These are not necessarily full-feature gaps, but they affect operational smoothness.

### Founder Copilot scope

Founder Copilot is good at rollups, but it is still more of a visibility layer than a true action layer outside marketing.

### Monitoring visibility

Monitoring exists more as a backend process than as a founder-facing operating surface.

### Support-to-engineering handoff

The support workflow is useful, but the technical escalation path still feels separate instead of continuous.

### Mixed maturity inside the War Room

Some cards are highly real and useful. Others are intentionally partial. The dashboard should make that maturity gradient more explicit.

---

## Possible Bugs Or Operational Gaps

These are the areas most likely to create confusion or friction even if the code is behaving as written.

### The engineering card can over-promise

If a founder sees an engineering lane in the War Room, it implies an engineering workflow exists there. Right now it does not.

### Facebook can create review noise

A founder can spend time reviewing Facebook-related draft work even though the execution path remains intentionally unavailable.

### Monitoring can be too invisible

If repeated low-grade issues accumulate, the founder may only notice once they surface elsewhere.

### Canonical truth is still split in practice

Incident is canonical for ops truth, but support, lifecycle compatibility logic, and legacy issue routes still make the total picture feel more fragmented than ideal.

---

## What Is Already Excellent

These are the parts of the dashboard that feel closest to production-grade founder operations.

### 1. Marketing founder layer

This is the strongest current operating surface.

Why:

- Founder Daily Log is practical
- Quick Actions are genuinely useful
- Today’s Ready Posts is clear
- packet detail is governed and reviewable
- approval-first logic is disciplined
- LinkedIn readiness is explicit rather than implied

### 2. Approval-first system design

The dashboard does not pretend the agents are more autonomous than they are.

That is a strength, not a weakness.

### 3. Support Ops structure

Support has a credible operational shape now:

- ticket queue
- grounded context
- generated response packets
- manual admin reply
- FAQ candidates
- insight generation

### 4. AI Control Room summary model

The top-level control room gives Samantha a credible “where is pressure building?” view without making her drop immediately into raw records.

---

## Recommended Build Order

If you want the most logical sequence from here, do it in this order:

1. Build the engineering/CTO dashboard workspace.
2. Unify support, incidents, and engineering into one escalation path.
3. Add a founder support/incident action layer.
4. Add a real monitoring surface.
5. Decide Facebook: ship it or defer it cleanly.
6. Reduce legacy compatibility confusion.

---

## Bottom Line

The admin dashboard is already very good at:

- visibility
- governed drafting
- approvals
- founder-ready marketing operations

It is not yet equally strong at:

- technical execution workflow
- unified support-to-engineering escalation
- dashboard-native monitoring

If those three areas are tightened, the dashboard moves from “strong founder visibility and governed operations” to a much more complete internal operating system.
