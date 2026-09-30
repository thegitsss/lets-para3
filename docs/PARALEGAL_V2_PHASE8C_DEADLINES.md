# Paralegal V2 Phase 8C — Matter deadlines and private reminders

## Scope completed locally

Phase 8C connects the existing deadline authorities to the persistent paralegal V2 Matter workspace. It does not add a schema, status, notification type, email, Matter lifecycle transition, or payment behavior.

The workspace now separates two records that were previously easy to conflate:

- the Matter deadline is the shared, authoritative date projected from `Case.deadlineDate` with the existing legacy `Case.deadline` fallback;
- a calendar `Event` is an owner-scoped private reminder, even when its `caseId` references the Matter.

The Matter deadline remains read-only in an active paralegal workspace. Existing Case rules permit only the Matter attorney or an admin to edit a Case, lock ordinary edits once work is in progress or a paralegal is hired, and do not provide the assigned paralegal with a deadline mutation route.

## Exact Event lifecycle preserved

The current `Event` model has no `status`, `done`, or `completedAt` field. Phase 8C therefore does not invent a reminder-completion transition.

For an active, authorized Matter, the V2 deadline section exposes only the currently implemented owner-scoped actions:

- create a private all-day `deadline` Event through `POST /api/events`;
- edit the owner’s Event through `PATCH /api/events/:id` while resending the Matter ID so current participant access is rechecked;
- delete the owner’s Event through `DELETE /api/events/:id` after an inline confirmation step;
- list the current owner’s Matter-linked deadline Events through `GET /api/events?caseId=...&type=deadline`.

Every successful create, edit, or delete is followed by a server refetch. The UI does not manufacture an authoritative Event record or optimistically remove one. Duplicate submissions are blocked while the request is pending.

Completed and archived Matter views retain the shared deadline and any currently readable reminder evidence, but V2 renders the section without create, edit, or delete controls.

## Visibility and notification determination

The Event list query always filters by `owner: req.user.id`. An attorney and paralegal on the same Matter therefore have separate reminder lists. The existing `visibility` field and its `case_team` enum value do not make Events visible to the other participant under the current route behavior.

Existing Event mutations create `AuditLog` actions (`calendar.event.create`, `calendar.event.update`, and `calendar.event.delete`). They do not create LPC Notifications or send email. Phase 8C preserves that behavior rather than inventing deadline alerts.

Home now merges active Case deadlines with owner Event reminders. Previously, the presence of any Event caused every active Case deadline to be dropped from the Home calendar source. The merged projection deduplicates identical Case/date/title entries while ensuring a private reminder cannot hide the shared Matter deadline.

Server-confirmed reminder changes invalidate Home in the current tab and are broadcast to other open V2 tabs. An already-open Home calendar refetches without reloading the document. Deadline panels also poll every 15 seconds while visible as a fallback.

## Stale access and deep links

- A `401` exits the protected shell through the existing session-loss boundary.
- A `403` while reading or mutating a linked reminder closes the Matter view and revalidates Case authority.
- A Case-level `404` closes the Matter view without retaining prior confidential content.
- An Event-level `404` during edit/delete is treated as a stale reminder: the list refetches and no local success state is fabricated.
- `tab=deadlines&eventId=<ObjectId>` is allowlisted only inside an authorized Matter route and focuses the matching private reminder when it exists.
- Leaving the Matter route aborts pending requests and closes polling and BroadcastChannel resources.

## Characterized limitations retained

- `Event` is a personal calendar record, not a shared Matter deadline or shared Matter calendar.
- Event routes do not emit LPC notifications or emails.
- The Event model has no completion lifecycle.
- The Event DELETE route is owner-scoped but does not independently recheck current Case participation. Its mutation affects only the owner’s reminder and never the Case. V2 removes all reminder controls as soon as Case access loss is detected.
- The Event list is capped by the existing route maximum of 200 records per request.
- Historical reminder visibility remains dependent on the existing Case-participant access check; Phase 8C adds no archival exception.

## Verification

- Targeted Jest: 5/5 suites and 25/25 tests covering Matter/Event authority, Matter experience, Home, deep-link, and Phase 8C contracts.
- Browser coverage: server-confirmed create/edit/delete, duplicate submission protection, stale authorization, historical read-only behavior, deep-link focus, same-Matter multi-tab sync, already-open Home sync, Assistant-open containment, Axe, and widths 320, 360, 375, 390, 430, 768, 1024, 1440, and 1920.
- Integrated Phase 7/8A/8B/8C browser matrix: 72/72 across Chromium, Firefox, and WebKit.
- Complete Jest under Node 24.18.0/npm 11.16.0: 205/205 suites and 1,551/1,551 tests.
- Static gates: 652 JavaScript files parsed; frontend hygiene passed for 37 HTML entry points, 500 local asset references, 85 reachable modules, and 42 reachable stylesheets; all 261 frontend API literals resolved against 356 routes; performance passed at 5,442.5 KiB; diff whitespace passed.

All work remains local and uncommitted. Nothing was deployed, and no production or Stripe data was accessed.
