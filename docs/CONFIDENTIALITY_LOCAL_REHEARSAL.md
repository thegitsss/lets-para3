# Historical confidentiality remediation: local rehearsal

`backend/scripts/remediate-confidentiality.js` supports a reviewed local rehearsal. It does not accept remote databases, load `.env`, inherit `MONGO_URI`, modify S3 objects, or migrate production. The October 12 `review3` return passed all 14 remediation tests, including actual CLI execution and interrupted-plan resume.

The tool prepares changes for historical message content and attachment aliases, CaseFile metadata/history and lookup identities, and confidential copies inside message notifications. Other notification types, recipients, routing references, read history and record identities remain outside its changes. Existing ciphertext must authenticate. Malformed ciphertext, a wrong key or contradictory file identity creates a hold; any hold prevents applying that plan.

The plan contains original and proposed fields inside an AES-GCM authenticated encrypted envelope, preserving BSON identities, dates and integer references. Its backup key must differ from the application data key. Plan directories must already exist with owner-only permissions, and plan files are created exclusively with mode `0600`. Symlink paths and replacing an existing plan file are rejected. Keep the independent backup key in secure configuration; do not place either key or confidential records in chat or audit output.

## Local execution

Use an isolated loopback replica set with synthetic records or a separately approved isolated restore. Supply these variables through secure local configuration:

- `CONFIDENTIALITY_MONGO_URI`: explicit `mongodb://127.0.0.1:PORT/DATABASE`, optionally specifying `replicaSet` or `directConnection`.
- `CONFIRM_CONFIDENTIALITY_TARGET=ISOLATED_NON_PRODUCTION`.
- `DATA_ENCRYPTION_KEY`: the key that authenticates this isolated dataset.
- `CONFIDENTIALITY_BACKUP_KEY`: independent 32-byte key encoded as 64 hexadecimal characters.

With the prescribed Node runtime, run from `backend`:

```sh
node scripts/remediate-confidentiality.js --mode=plan --plan=/private/tmp/OWNER_ONLY_DIRECTORY/plan.json --limit=10000
```

Review the private encrypted inventory, target and counts. The command emits counts and the envelope SHA-256, with no message contents or record identifiers. A limit overrun stops planning instead of silently truncating it. Applying or rolling back requires that exact approved envelope digest and `CONFIRM_CONFIDENTIALITY_WRITES=REVIEWED_ISOLATED_PLAN`:

```sh
node scripts/remediate-confidentiality.js --mode=apply --plan=/private/tmp/OWNER_ONLY_DIRECTORY/plan.json --approved-sha256=REVIEWED_ENVELOPE_SHA256
node scripts/remediate-confidentiality.js --mode=rollback --plan=/private/tmp/OWNER_ONLY_DIRECTORY/plan.json --approved-sha256=REVIEWED_ENVELOPE_SHA256
```

## Stop, resume and recovery

Transactions are per record, not one transaction for the entire inventory. An error can leave earlier reviewed records committed. Retain the immutable plan. Repeating the same operation recognizes exact completed records and resumes without double encryption. Compare-and-set verifies the original document and exact changed fields; newer changes stop the operation without being overwritten. Rollback restores only reviewed changed fields and also refuses intervening edits, including changes to unrelated fields. Do not erase a newer user edit to make a plan pass; reconcile it and prepare a new reviewed plan.

Retain the command exit status, count-only results, encrypted plan digest, candidate identity and separate hold disposition. Verify unchanged record counts, decrypted equivalence, file identities/history and notification routing in the isolated database. Local rehearsal does not establish Atlas snapshot recovery, object-version recovery, production RPO/RTO, authorization on a restored production clone or owner-approved production execution. Those remain release requirements in `docs/RELEASE_GATES.md` and the prepared October 9 production-change plan.

## Recorded local recovery return

The October 12 `review3` rehearsal used the real backup/restore scripts and MongoDB dump/restore tools against two independent temporary replica sets. Seven synthetic records across five collections, their BSON values and indexes survived namespace-remapped restoration. The restored database then passed CLI plan/apply, repeat-safe resume and exact rollback, with decrypted message/file equivalence and notification routing preserved. Both temporary databases were stopped. Count-only results and artifact digests are retained in `outputs/workspace-completion-20261012/restore-rehearsal3/result.json`; this is local synthetic recovery evidence.
