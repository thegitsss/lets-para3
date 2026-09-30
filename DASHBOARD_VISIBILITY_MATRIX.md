# LPC dashboard visibility matrix

Audit date: 2026-08-29. This matrix records current behavior at the audited working-tree snapshot; it is not a Dashboard V2 design.

## Reading the matrix

- **A** = owning attorney; **P** = relevant paralegal; **Admin** = authorized admin/director route where implemented.
- “Visible” means the current query and client rendering should include the item. “Hidden” means it is filtered or access is denied. “Historical” means a receipt/completed/application/notification record may remain while live actions disappear.
- Case state, Job state, Application history and UI projections are separate. A row can therefore be visible in one surface and intentionally hidden in another.

## Opportunity and engagement visibility

| Lifecycle condition | Home | Browse Matters | Search results | Recommended matters | Applications | Invitations | Active matters | Direct/deep link |
|---|---|---|---|---|---|---|---|---|
| Draft | A create/resume flow only | Hidden | Hidden | Hidden | Hidden | Hidden | Hidden | Owner draft route only |
| Open published, no relationship | A posting/open count; P opportunity feed | Visible to eligible approved P unless blocked | Discoverable open result | P only when state **or** practice matches and years meet minimum | None | None | Hidden | P Details allowed under open-discovery authorization |
| Open, P submitted/viewed/shortlisted | A pending-app totals/queue; P application section | Still present in feed and annotated | P may find via relationship/open discovery | Suppressed while application is in client's active cache | Visible to P; visible in A candidate queue | None unless separately invited | Hidden | Applicant Details allowed; other candidate information is suppressed |
| Application rejected | A active queue removes; notification/history may remain | Open matter remains browseable | Open discovery can return | **Can reappear incorrectly** because rejected history is filtered from exclusion cache | Hidden by current P active-app filter | N/A | Hidden | Old actionable links sanitize/deny; fresh open Details may still resolve |
| Application withdrawn | Both active queues remove | Open matter remains browseable | Open discovery can return | **Can reappear incorrectly** because API hides withdrawn history | Hidden by API and client | N/A | Hidden | Old relationship link sanitizes; open Details can resolve; reapplication is allowed by current server behavior |
| Application accepted but hire not complete | A/P candidate/application projections depend on flow timing | Matter remains until hire assignment closes posting | Relationship result can remain | Can be absent only while accepted history is loaded; active filter removes accepted | Current P active filter removes accepted | Accepted invite moves out | Not active until funded hire succeeds | Race window among accept, hire and posting refresh |
| Pending invitation | A invitation management; P prompt/count | Matter may still be open | Open result may appear | Recommendation does not use invitation history as a durable exclusion | Application may exist only after accept | Visible/actionable to invited P | Hidden | Invite action allowed while Case remains eligible |
| Declined/expired/revoked invitation | Active invite rows disappear; historical notification may remain | Open matter remains | Open result may appear | No durable invitation-history exclusion | Invite-derived rejected/withdrawn Application may be hidden | Hidden | Hidden | Stale action becomes informational/denied |
| Hired, funded, `in progress` | A/P active summaries and action queues | Job should disappear (`assigned`) | Only authorized-object result for participants/admin | Hidden | Winner/losers move out of active queues | Other invites expire/reject | Visible to A and assigned P | Workspace, messages/files/tasks/deadlines allowed to participants; blocked for outsiders |
| Paused after P withdrawal | A withdrawal action; former P historical/payout item | Visible again after finalization/relist | Relisted discovery for other P; relationship evidence for former P varies by endpoint | Eligible for others; should be excluded for former P but is not reliably | Former P's Application is withdrawn and hidden | New invites possible only after relist gates | Removed from active | Former P workspace denied; specialized Assistant may read pre-revocation evidence; attorney/admin retain eligible access |
| Disputed | A/P/Admin dispute/payment actions | Hidden | Participant/admin authorized result only where search policy allows | Hidden | Historical only | Hidden | Excluded from active workspace lists | Live workspace/message/file access closes or is restricted; dispute/payment deep links remain role-gated |
| Completed and paid | A/P completed/history and receipts; no active row | Hidden | Historical authorized result may be role-specific | Hidden | Historical only | Hidden | Hidden | A can access archive/history; P direct Case workspace GET is denied and P uses completed/receipt projections |
| Closed | Historical/admin depending reason | Hidden | Historical authorized result only | Hidden | Historical only | Hidden | Hidden | Terminal; direct link requires retained ownership/role policy and may sanitize |
| Deleted never-engaged | Removed | Removed | Removed | Removed | Related Applications deleted | Related records may become stale unless separately handled | Removed | 404; notification action should be removed |
| Active Block pair | Existing qualifying history remains | Pair-specific Jobs/profiles hidden | Pair-specific results suppressed | Suppressed through discovery feed | Historical records retained; new apply denied | New invite denied | Existing active engagement cannot be used as the prerequisite for creating the block | Messages/new interaction denied; deep links sanitized/denied |

## Home dashboards and totals

| Element | Attorney Home source and rule | Paralegal Home source and rule | Admin surface | Known mismatch/risk |
|---|---|---|---|---|
| Active matter total | Attorney dashboard counts current/legacy active statuses | Paralegal dashboard counts assigned current/legacy active statuses | Admin case queries | Attorney `activeCases` summary query is broader than its numeric metric and may include open/paused/disputed rows while the metric does not |
| Open postings/opportunities | `Job(open)` for attorney | `/api/jobs/open` plus client recommendation ranking | Admin Jobs/Cases | Job and Case can drift after edit/relist; no single recommendation query |
| Pending applications | Submitted/viewed/shortlisted variants across routes/clients | Paralegal backend count is only `submitted`; frontend active list includes more states | Admin/application routes | “Pending” is not consistently defined; Applications API hides withdrawn and frontend additionally hides rejected/accepted/inactive jobs |
| Invitations | Invitations routes/client pending filter | Pending invitation modal/list/count | Admin access where implemented | Invitation and Application mirrors can diverge and mark reconciliation |
| Unread messages | Message unread endpoints and dashboard fetch | Same | Admin only when participant/authorized | `/unread-count`/summary use `messageLastViewedAt`; thread aggregation relies on receipts/readBy, so totals can disagree |
| Unread notifications | Latest 100 Notification records, client counts unread | Same | Admin notifications/incident surfaces | More than 100 unread records can understate badge total |
| Upcoming deadlines | Case `deadlineDate` for active status plus frontend Event feeds where used | Case deadline and owner-specific Events where client merges them | Admin Case/Event views | Legacy Date fallback is used by Assistant but not all dashboard queries; Events are owner-local, not a shared matter calendar |
| Attorney escrow total | Dashboard attempts optional `Payment` model | N/A | Payment/admin views use Case/Payout evidence | No Payment model is present, so this dashboard total resolves to zero while `/payments/summary` and escrow routes are authoritative |
| Paralegal earned total | N/A | Payout aggregation plus finalized partial-withdrawal Case fallback, de-duplicated by Case | Payment/admin receipts | Multiple records are intentionally merged; late webhook/reconciliation can change value after first render |
| Expected payout | N/A | Active assigned Cases | Payment/admin views | Depends on active status aliases and current assignment; no live push dedicated to total |
| Application/Job counts | Job `applicationsCount` plus Application queries | Application collection/client cache | Admin lists | Count is mirrored and repaired/synced separately; failure becomes stale count |
| Priority/action queue | Candidate, payment, dispute, deadline projections | Invitations/messages/deadlines/payout readiness and current work | Admin dispute/account/incident queues | Dashboard contract tests check markup/copy more than cross-role state transitions |

## Detailed surface behavior

| Surface | Inclusion source | Removal/move trigger | Empty/stale/deep-link behavior | Coverage status |
|---|---|---|---|---|
| Attorney Home | `/api/attorney-dashboard`, notification/message/event fetches, client projections | posting deletion; hire; completion; dispute/withdrawal state changes | Fetch-on-load plus selected events; metric/summary status predicates differ | Static/dashboard route tests; no full two-browser transition suite |
| Paralegal Home | `/api/paralegal-dashboard`, `/api/jobs/open`, `/api/applications/my`, invites, events/messages/profile; client recommendation ranking | apply/hire/withdraw/complete/block/filter changes | Loading order among profile, Jobs and application cache can briefly mis-rank; no durable historical exclusion | `matchingDiscovery.test.js` covers basic match only; historical states missing |
| Browse Matters | `/api/jobs/open` merged Job/eligible relist Cases | Job assigned/closed, Case final/archive/assignment, block | Orphan/stale Job or incomplete relist metadata can show the wrong card; Details re-authorizes | Basic discovery tests; Job/Case drift scenarios incomplete |
| Search results | Authenticated search authorization per object/relationship | block, reject/revoke, finalization, access revocation | Result deep link is separately authorized; rejected/revoked/blocked suppression tested | `authenticatedSearch.test.js` is comparatively strong |
| Recommended matters | Browser-side `rankRecommendedMatters()` over open feed using state/practice/years and active application IDs | Active Application cache match, years mismatch, no state/practice match | Historical rejected/withdrawn/inactive applications can return; refresh order/multi-tab risk | Required historical characterization missing |
| Applications | `/api/applications/my` plus `isActiveApplication()` | withdrawn excluded server-side; accepted/rejected/non-open removed client-side | This is an active work queue, not a history ledger, despite domain history existing | Application flow tests; presentation semantics and history absence need characterization |
| Invitations | Invitation query and modal/client filter | accepted/declined/expired/revoked | Stale notification actions are sanitized; simultaneous tabs can show an obsolete modal until action fails/refetch | Flow tests strong, browser refresh tests weak |
| Active matters | Dashboard active-status and assignment queries | pause/dispute/complete/close/revoke | Direct workspace rechecks authorization and funding; rendered old tab persists until another request/refetch | ACL/lifecycle tests strong; multi-tab browser behavior missing |
| Messages | Active funded workspace authorization and Message records | dispute/pause/completion/block/access revocation | Every API request rechecks access; unread totals differ by endpoint | Message API tests strong; count consistency missing |
| Files | CaseFile + Case file mirror; active workspace ACL | access revocation/final state/security blocked | Direct download re-authorizes and checks scan state; P completed workspace unavailable | Upload/ACL tests; mirror reconciliation coverage incomplete |
| Deadlines | Case `deadlineDate`, legacy date mirror, and owner-specific Event | Case finalization/deletion or Event update/delete | A/P may not share owner-created Event; Assistant may show fallback not seen on dashboard | Event/unit coverage; cross-role deadline visibility missing |
| Notifications | Latest 100 authorized Notification records plus presentation sanitizer | clear/delete/read; stale target loses CTA rather than necessarily disappearing | Deep-link policy is a second gate; SSE plus polling refresh | Presentation/preferences/SSE tests; >100 unread and multi-tab read consistency missing |
| Payment views | Case escrow/funding evidence, Payout, PaymentOperation, Stripe/webhook projections | funding, transfer, refund, reversal, reconciliation | Role/ownership receipt endpoints; final records retained | Payment/dispute tests strong; dashboard-vs-payment-total consistency missing |
| Counts and badges | Endpoint-specific aggregation plus client caches | domain transition and subsequent fetch/SSE/client event | No universal projection version; aliases/filter differences produce transient or persistent discrepancies | Mostly endpoint tests; no lifecycle-wide assertion set |
| Direct/deep links | `objectDeepLinks` allowlist plus target route authorization | relationship removal, finalization, block, archive/access revocation | Stale notifications become informational; unauthorized target returns 403/404 rather than relying on hidden UI | `objectDeepLinks.test.js`, `authenticatedSearch.test.js`, notification presentation tests |

## Role-specific movement rules

| Domain event | Attorney should see | Paralegal should see | Admin should see |
|---|---|---|---|
| New application | Candidate row/count, notification/email | Application submitted | Audit/application data |
| Reject/withdraw | Candidate leaves active queue; count resyncs | Application leaves active list; safe notification/history only | Historical Application remains unless Case is deleted |
| Invite/accept/decline | Invitation/candidate status and notification | Invite action then Application state | Invitation/Application and sync state |
| Hire/fund | Matter moves from posting/candidates to Active; billing/escrow updates | Matter moves from application/invite to Active; messages/files enabled | Funding evidence, Case/Job/Application transitions |
| Message/file/deadline | Workspace item and unread/review action | Workspace item and unread/review action | Only authorized operational/admin view |
| Withdrawal | Payout decision/dispute action; matter paused then relisted | Active matter removed; payout/dispute historical item | Withdrawal clock, dispute/reconciliation/relist state |
| Completion | Completed/history/archive/receipt; Active removed | Completed/earnings/receipt; Active and workspace removed | Payout/ledger/archive evidence |
| Refund/reversal/dispute settlement | Billing/history and notification | Earnings/payout/dispute outcome where affected | Payment operation, webhook, dispute and reconciliation state |
| Block | Future candidate/profile/opportunity interaction suppressed | Same pair-specific suppression | Block record and qualifying source |
| Account deactivation | Counterparty history retained; active opportunity relationships close | Same | Disabled account plus retained history/ledger and cleanup state |

## Visibility rules that must be characterized before Dashboard V2

1. A historical Application in every status must remain a discovery/recommendation exclusion if that is the intended product rule, while Browse behavior and direct Details behavior are asserted separately.
2. Every lifecycle transition must assert the same Case/Job/Application across both role dashboards, counts, notification actions and direct links.
3. “Active,” “pending,” “historical,” and “unread” must be captured as the exact current predicates per endpoint before any V2 aggregation changes.
4. Payment cards and dashboard totals must be compared against authoritative receipt/summary routes after funding, payout, refund, reversal and reconciliation.
5. A second session/tab must prove that stale rendered UI cannot perform an unauthorized action after hire, withdrawal, dispute, completion, block or account deactivation.
