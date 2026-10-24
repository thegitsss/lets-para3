# Attorney Matter conversation

The attorney Messages section now supports bounded conversation reads, older-page and exact-message navigation, sending, private tab drafts, exact-request delivery recovery, editing, pinning, reactions, confirmed soft deletion and read acknowledgements. Existing thread references retain their message links. The existing text POST does not create replies or thread roots despite its old comment; no new thread-creation or recording capability is implied.

## Authority and preservation

The optional `expectedOwnerId` read returns at most 50 messages in stable date/id order, with a next cursor or exact linked-message context. It omits storage keys and sender email. Only the current attorney's private request IDs are exposed for exact delivery recovery. Ordinary legacy GET remains the existing full conversation read, including its last-viewed side effect. The new bounded GET has no read acknowledgement side effect; the mounted visible conversation calls the existing `/read` operation with the loaded message date. Read receipts and last-viewed records remain their existing separate stores, not an invented unread count.

Strict reads verify the current approved attorney, token version, active session, owner, assignment, funding, work status and blocks before and after loading. Strict writes repeat this account/Matter check before recording. Edit/pin/reaction/delete saves also compare the editable message actually reviewed, including raw persisted text and reaction fields, while preserving unrelated fields and excluding read acknowledgements from the edit revision. These checks do not claim a transaction spanning every account and lifecycle change.

The existing message action routes reloaded the Matter without the funding fields their permission policy requires. Their projections now include funding evidence. Existing attorney and paralegal edits/reactions succeed on funded Matters and remain denied when funding is removed. Both-role notification consumers are covered. Message paging adds a compound Case/date/id index; its operational creation belongs in final candidate and release indexing checks.

Unsent and unconfirmed message text stays in the current page's private state across section changes. It is never stored in browser storage or URLs. Account protection and verified access loss erase it. A temporary Matter read failure hides the old page while retaining the draft for the next verified read. A lost send response checks the exact request ID, never matching message text or time; explicit retries retain that ID. A definite validation rejection leaves the text editable. A stale edit retains the proposed text and displays the current saved message for renewed review.

The Matter component owns its stream, polling fallback and presence calls. It coalesces stream events, avoids overlapping refreshes, closes the stream on visibility/access/route changes, and preserves the composer during incoming updates. The existing provider owns reconnects. Presence expires on the server; this is not proof of multi-instance operational presence parity.

## Evidence and retained failures

Checkpoint: `backend/backups/attorney-v2-phase7-conversation-start/`, 2,134 initial file hashes and 16 owned paths. Private candidates are manifest-verified copies; Node 24.18.0, ephemeral MongoDB, Chromium/Firefox/WebKit, one browser worker and zero retries.

The six final backend/client/consumer suites passed **57/57** on candidates 6 and 10: attorney conversation, conversation model, existing messaging notifications, paralegal conversation contract, workspace boundary and workspace model. `logs/backend-10.log` retains the exact command/result. This includes 125 equal-date messages across three pages, stable old-message links, omitted private fields, actual read-date effects, duplicate and changed request IDs, stale edits, both-role action permissions, account revocation during reads/sends, closed states and the initialized paging index.

Candidate 5 browser pass: **48/51**. All three failures were the same test expectation that an old Matter URL would remain after account protection; the product cleared and redirected correctly. Candidate 7: **56/57**. One WebKit clock test advanced to its second poll while the first asynchronous refresh still completed. The test now waits for the actual Matter refresh control, and the product disables overlapping explicit refreshes. Failure logs and traces remain in their original candidate folders. Candidate 8 then passed 59/60; its sole failure read the account-switch URL synchronously after confidential content had cleared but before redirection completed. Candidate 9 passed 38/39 conversation scenarios, with that same timing expectation in Chromium. Candidate 10 changed the assertion to await the actual redirect and passed that exact scenario in all three engines (3/3). The other 38 conversation scenarios and all 24 workspace scenarios passed on the latest applicable runtime. These are reported as their recorded runs, not as an uninterrupted combined pass. The validation-rejection check verifies that rejected text remains editable instead of trapping the composer in delivery recovery.

API characterization resolves 428 frontend literals against 402 mounted patterns. Hygiene has 19 unowned admin/paralegal-preview findings after correcting the owned empty presence catch. Runtime bindings retain the unowned Zoho mailbox parameter finding. Chromium's narrow conversation screenshot was visually inspected; full LPC shell/layout/editorial acceptance remains open.

## Remaining Phase 7 work

This accepts no claim of complete collaboration yet. File selection/upload/progress/cancellation, guarded attachment previews and audio playback, review/revision/version lineage, shared work controls, dates/events, thread-list navigation, complete unread/global notification convergence, historical conversation permissions and final combined cross-role acceptance remain active. Current active-conversation permissions still deny paused/completed/disputed Matters. The rebuild must characterize authorized retained-history routes before changing that rule.

No production cohort was enabled, no real provider charge or email was sent, and no V1 route was retired.

Accepted runtime: `/private/tmp/lpc-attorney-review-20260907-conversation-10`, 1,426 manifest-verified files. Candidate 11 contains only the final evidence documentation update. Full suite acceptance and the remaining Phase 7 work are still required before owner final review.
