# Approved Create a Matter A → E implementation

Implemented September 21, 2026 from the supplied Option A and Option E HTML. Exact reference copies are in `outputs/matter-canvas-before/approved-a.html` and `approved-e.html`.

- Global New Matter opens an owned native dialog above the existing workspace; the route, outlet DOM, filters, and scroll position remain intact. Sidebar Create new and the competing Matters heading plus were removed.
- A retains the 690px composer, 52px header, restrained veil, examples, quiet manual action, and navy primary action. It expands in place into the E split canvas. No extra dialog, route, or wizard is introduced.
- The source textarea is the same DOM element through expansion. After generation it is read-only source material; structured values edit inline on the right. Original text is saved separately as the optional `CaseDraft.sourceDescription`. Older drafts without source text are identified honestly rather than presenting generated scope as original text.
- Autosave, conflicts, uncertain outcomes, requirements, explicit publication confirmation, attorney-side fee calculation, and funding-on-hire behavior reuse existing contracts. Successful publication closes creation and opens the resulting Matter after cleanup has been attempted.
- Escape, backdrop dismissal, keyboard containment, opener focus, reduced motion, session loss, and refresh recovery are covered. Session storage contains only owner and draft identity/step metadata, never source or Matter text. Opening and closing do not require saving manually; uncertain writes keep explicit recovery controls.
- Review offers section corrections within the same surface. Manual entry uses the same canvas.

## Verification scope

`creation-canvas.spec.js` runs the real LPC shell and API client with controlled authenticated API fixtures, including realistic medical-chronology data, Chromium/WebKit, 1024/1600/390px layouts, errors, publication recovery, source persistence across refresh, and accessibility checks. Screenshots are in `outputs/matter-canvas/`.

Database tests use the repository's isolated MongoDB harness. No real Matter was published or funded. This is focused feature verification, not whole-product release certification. No deployment, commit, or push was performed.

## Fee disclosure timing

The editing canvas and Matter posting preview show compensation only. After Publish Matter is selected, the final confirmation shows compensation, the attorney-side 22% platform fee, and the total due when hiring. The attorney sees this breakdown before Confirm and publish Matter. Canceling confirmation hides the breakdown; changing compensation updates it on the next confirmation. The $400 minimum remains compensation before fees. Twelve focused browser checks passed, including Chromium/WebKit confirmation and recovery paths plus manual/AI composer compatibility. No real Matter was published.

## Manual entry

Manual entry opens the same inline-editable Matter document in a single-column, 760px maximum-width surface, without the source-description panel. Text entered before choosing manual entry remains in scope. A manual draft has no separate sourceDescription; this keeps the correct layout on refresh and reopening without extra route state. Autosave status remains visible within the document. Generated drafts retain their original source and split canvas.

## Start new Matter

The creation header has a quiet options menu beside close, containing Enter details manually and Start new Matter. Starting a new Matter asks for confirmation when there is work in the current draft; Cancel or Escape preserves it. Empty composers skip the confirmation. It flushes the current draft before opening a new composer with a fresh request identity. Failed saves retain the current editor and expose existing save recovery. Close still resumes the current composer. Starting over is disabled during publishing confirmation or uncertain publication; session changes and closing during a pending switch cancel the switch. Saved drafts remain available from Matters.

The opening uses the approved copy: “What needs to get done?”, “Just tell LPC.” and “Messy notes are fine. We’ll shape them into a Matter.” Build my Matter is the only visible primary action. The menu supports keyboard navigation, outside-click dismissal, and Escape. The inline start-over confirmation prevents editing beneath it until canceled or accepted.

## Back navigation

The canvas, Review, and final publishing confirmation expose ← Back. Returning to the opening composer preserves the current draft; manual scope carries into the description input. Rebuilding an existing draft uses the existing explicit revised-draft acceptance instead of silently replacing edits. No Back action appears at the initial step.


## Creation fidelity and interaction refinement — September 22, 2026

The approved A → E composition is retained. Generation preserves explicit quantities,
limitations, and event timing; only directly requested deliverables belong in the Matter.
A second schema-bound model check rejects unsupported additions, omitted details, and
changed meaning before returning suggestions. It never writes Matter fields. This is a
probabilistic quality gate, not proof of factual accuracy, and adds provider latency/cost.
The response contract and attorney-controlled financial/date fields are unchanged.

Inline values gain a quiet hover/focus treatment. Step transitions focus the source
textarea, Matter title control, or review heading instead of the entire fieldset.
Generation failures preserve notes and expose Try again. Canvas save recovery uses
one Retry save action: check the existing save first, then save only if reconciliation
succeeds; conflicts, missing records, restrictions, and publication checks retain their
existing explicit recovery paths. No publication or payment authority changes.

Verification: mocked-provider endpoint tests and authenticated-fixture browser coverage.
Live-provider evaluation was blocked by automatic approval review; no live model quality
or latency claim is made. Attorney usability validation remains separate.

### Opening composer alignment with Home and Matters

The opening now reuses the Home/Matters 28px Sarabun title hierarchy (24px on
small screens), shared ink/muted/line/surface colors, 5px control radii and compact
36px action sizing. A 32px desktop / 24px mobile inset groups the approved headline,
supporting sentence, writing field and action. The field begins at three lines and
expands with input, restored notes and width changes. Example links are removed from
the canvas opening; the approved Wednesday placeholder provides the starting point.
The source panel, manual entry, generation and publication contracts remain intact.

### Explicit practical details from Build my Matter

Generation can now return source-quoted compensation, work-deadline text and state.
The existing fidelity check reviews those details; server normalization requires that
quotes occur in the attorney's request and validates each value before returning it.
Only exact flat USD compensation is populated. Hourly amounts, ranges, estimates and
fee-inclusive totals are left for the attorney. This does not alter the $400 minimum,
fee timing, confirmation, funding, or publishing contracts.

Named month/day deadlines without a year use the next upcoming occurrence, as approved
by the user. ISO dates, explicit years and supported relative day/weekday phrases use
calendar-date arithmetic. Event dates alone do not become work deadlines. Date fields
and review show the full year. Unrecognized/ambiguous date formats remain unfilled.

Initial explicit state can supersede a profile default. Existing amounts/dates and
established draft states remain unchanged on rebuild; field edits (including clearing
an input during the current editor session) are protected. Extracted additions in a
rebuild are included in the existing revised-draft acceptance preview. Autofilled values
use normal draft autosave and remain editable. The original notes remain visible.

Verification: 39 focused backend tests and 12 Chromium/WebKit authenticated-fixture
checks passed. AI responses were mocked; this does not certify live model accuracy.
