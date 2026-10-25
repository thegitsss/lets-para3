# Presigned Matter upload compatibility

September 9, 2026. Locally verified under `backend/backups/attorney-v2-presigned-uploads-start/`; full attorney owner-review preparation continues.

## Result and authority

The existing API-only `/api/uploads/presign` now checks the fresh approved participant, account version, assignment aliases, active funded Matter, and completion/hiring claims through the shared file-write boundary. A Case-fenced transaction records the original owner, exact 60-second expiry, encrypted key and original bucket before the signed URL is returned. Preparation rechecks authority after signing and returns no URL on uncertain issuance, changed authority or elapsed expiry.

The PUT signs `If-None-Match: *`, content type and byte length. The response adds `requiredHeaders`; callers must send those headers with the exact declared bytes. Signing uses a dedicated client with `requestChecksumCalculation: WHEN_REQUIRED`, because the signer has no file body. The installed SDK otherwise binds the empty-body CRC32 to a later nonempty upload. Ordinary server uploads retain their existing checksum defaults. Optional supplied SHA-256, encryption and content-disposition settings remain signed. No current frontend presign callers were found in the source census.

Attachment and replacement record the lease against the exact document inside the existing Matter transaction. Another participant cannot adopt that upload identity. Earlier keys without issuance records retain the characterized verified-object path. An expired link may finish attachment before its cleanup transaction wins; once retired, its permanent key tombstone prevents a late attachment.

The retirement worker now sweeps unused expired issuances, preserves the original bucket, and atomically fences the Matter and attachment before queuing storage cleanup. Issuance and HEAD are not proof that a PUT finished. Unconfirmed cleanup remains recurring; missing Matters and changed bucket configuration retain review evidence. Lease records have no TTL, so expiry does not erase outstanding cleanup evidence.

## Verification

- Candidate 1: 94/95 checks passed across four suites. The attachment assertion expected 200, while first creation correctly returns 201; the assertion was corrected. Duplicate attachment remains 200.
- Candidate 2: **103/103 checks passed across five suites**: `matterPresignedUploads`, `matterStorageRetirement`, `uploadsDownloads`, `attorneyMatterFileRemoval`, and `outboundNetworkPolicy`. Node 24.18.0, serial Jest, isolated temporary MongoDB replica set, explicit synthetic credentials and mocked provider requests.
- The installed SDK subprocess signs locally without contacting storage. It checks the actual shared client factory, ordinary uploads without a precomputed checksum, signed condition/type/length, optional KMS/encryption/disposition/SHA-256 headers, and rejection of incomplete signature metadata. No full signed URLs or credentials are logged.
- The API contract check resolves 454 literals against 422 mounted patterns. Runtime bindings report only the already-unowned `services/support/zohoMailbox.js:34` parameter. No frontend runtime files changed in this slice; previous browser evidence is not relabeled as a new run.
- Runtime source: `/private/tmp/lpc-attorney-review-20260908-presigned-2`, 1,519 manifest-verified files. `isolated-candidate-2.json` identifies exact hashes. The final documentation-only candidate and checkpoint retain before/after sources and the scoped patch.

## Operational acceptance still open

Real S3 acceptance, browser CORS for the returned headers, deployed IAM/bucket conditional-write policy, scanner behavior, and versioned-bucket lifecycle/deletion require their own authorized environment evidence. No provider calls, bucket changes or deployment occurred. Previously issued URLs keep their original expiry. Conditional writes protect the current object; deletion markers and PUTs already in flight remain relevant to recurring cleanup. See [AWS conditional writes](https://docs.aws.amazon.com/AmazonS3/latest/userguide/conditional-writes.html), [presigned URL behavior](https://docs.aws.amazon.com/AmazonS3/latest/userguide/using-presigned-url.html), and [JavaScript SDK checksum behavior](https://docs.aws.amazon.com/sdk-for-javascript/v3/developer-guide/s3-checksums.html).

V1 displayed-document binding, full earlier-file controls, whole-experience convergence, financial/account/global workflows and the LPC visual/editorial review remain open in `BUILD_CHECKLIST.md` and `FINAL_REVIEW_PREPARATION.md`. This slice does not make the attorney experience ready for final review or release.
