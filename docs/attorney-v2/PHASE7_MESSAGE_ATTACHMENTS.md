# Attorney message attachments

File and audio messages now open their exact recorded attachment from the conversation. Audio retains its transcript and has an explicit Load audio action with native playback controls. No recording capability or new message schema is added. Missing attachments and unsupported playback remain explicit; the protected download remains available for recorded contents.

## Authority and lifecycle

The source is the existing Message file reference, type, MIME, filename and transcript. The conversation DTO exposes an attachment capability and allowlisted audio MIME, with no object keys or arbitrary URLs. The message revision now includes attachment MIME and size as well as the prior editable fields.

GET `/api/cases/:caseId/message-attachments/:messageId` uses the common protected document stream. It checks the fresh account and current active-conversation policy, rejects contradictory owner/assignment aliases, verifies the exact message revision, and permits only a same-Matter document key. Account, Matter and message are reread before and after storage. A reference to contents retained before a replacement opens those contents, and its security check does not rewrite the current replacement's scan metadata.

The default response is a no-store, nosniff attachment. `play=true` permits only recorded audio/mpeg, audio/mp4, audio/wav, audio/x-wav, audio/ogg and audio/webm types. Playback is same-origin under the existing CSP; no blob-media or external-origin allowance is added. Download preparation verifies the browser account before and after receipt of the bytes. Native playback does not start automatically.

Unchanged background reads preserve message nodes and the active player. Changed/deleted messages, failed access checks and route disposal abort attachment requests, stop audio and release local download URLs. A late download cannot restore a previous conversation's private contents. The existing Matter stream and poll remain the only refresh owners.

## Local evidence

Checkpoint: `backend/backups/attorney-v2-phase7-message-attachments-start/`, with 2,578 initial hashes and 14 owned paths. All existing owned paths matched the accepted replacement candidate before edits. Private candidates exclude unrelated root changes.

- Candidate 1: **90/93** backend/client checks passed across five suites. The four server/consumer suites all passed. The three new client tests completed their assertions but their helper returned an exec buffer, which Jest rejects as a test return value. Candidate 3 changes that helper to return undefined and passes **3/3**; application source is unchanged.
- Candidate 3 passed **63/63 browser scenarios**: 24 attachment scenarios and 39 existing conversation scenarios across Chromium, Firefox and WebKit. This includes native downloads, actual WAV decoding and playback, no autoplay, unchanged polling, changed-message disposal, failed decoding, scanner/conflict states, access denial and late-response route cleanup. Narrow-width and automated accessibility checks cover 320/390/768/1366 widths; populated Chromium 320px and 1366px screenshots were visually inspected.
- API checks resolve **443 frontend literals against 412 mounted route patterns**. Supplemental owned frontend checks report no findings across five frontend sources with an 83-module entry graph. Runtime bindings retain the unrelated Zoho unused-parameter finding.

The current active-conversation boundary still denies paused, completed and disputed conversations; archive/history presentation remains separately tracked. Transcript text is rendered as text, including adversarial markup. No reminder/notification, storage-retention or historical-message permission change is implied. Full attorney review preparation, final LPC copy/layout, file removal/reconciliation and later phases remain open.
