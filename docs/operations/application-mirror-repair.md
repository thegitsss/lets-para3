# Inspect and repair one application mirror

This command exposes the existing guarded maintenance service. It is not a background job, automatic reconciliation, or permission to modify production records. Normal application actions do not invoke it.

From `backend/`, inspect the exact application, Matter and attorney owner:

```sh
npm run maintenance:application-mirror -- --application=<application-id> --matter=<matter-id> --owner=<attorney-id>
```

Select the intended database through `MONGO_URI`. Inspection is read-only: automatic collection and index creation are disabled. Output is limited to record IDs, status, whether a change is needed, the mirror count and an opaque revision. Retain this output privately with the issue record. Do not include connection strings, submitted application text or personal profile fields in shared evidence.

The service rejects missing, ambiguous, contradictory, closed or archived records. It verifies reciprocal application/Job/Matter relationships and attorney ownership. Existing conflicting mirrors require separate review; this command will not overwrite them indiscriminately.

After the operator reviews the exact target and inspection, an authorized repair uses the returned revision:

```sh
npm run maintenance:application-mirror -- --application=<application-id> --matter=<matter-id> --owner=<attorney-id> --apply --revision=<inspection-revision> --confirm=REPAIR_APPLICATION_MIRROR
```

The existing service rechecks the complete record revision inside its transaction. A changed record refuses the stale repair. Repeated repair of an already consistent relationship is a no-op. The canonical application status and history are preserved; this does not hire, select or notify a paralegal or initiate a payment.

Retain the before/after bounded summaries. If the command fails or the connection is interrupted, inspect again before considering another apply. Do not assume success from an interrupted command, bypass refusal, or automatically retry a write. Real target execution remains separate from local synthetic verification.
