# Résumé Autofill — local review, 2026-10-15

Status: implemented locally for review. Production processing is disabled. No deployment, real résumé processing, paid API call, live storage read, or provider configuration change was performed.

## Review the working flow

Open http://127.0.0.1:5068. The preview runs on loopback with an in-memory synthetic account. Its extraction is real local PDF/Word processing, not canned suggestions. Profile persistence and the existing stored résumé are synthetic in this preview. Download the provided synthetic PDF or Word file to try “Use a different résumé.” Use synthetic documents only.

To restart from the repository root:

```sh
PATH=/Users/samanthasider/.nvm/versions/node/v24.18.0/bin:$PATH node backend/scripts/preview-resume-import.cjs
```

The first-visit prompt uses the revised existing-résumé entry and exact requested copy. Nothing is extracted before “Autofill from my résumé.” The alternate upload is transient and never invokes the résumé-attachment replacement endpoint. “I’ll enter it myself,” dismissal, and Escape close the introduction. A per-account browser marker prevents automatic replay; “Fill from résumé” remains available in Profile Settings and the own-Profile preview. The marker contains no résumé data. A different browser/device has its own first-visit marker.

The animation runs once when the introduction is opened, with no loop or simulated progress. Reduced motion shows its settled state immediately. Actual processing has a separate status, cancellable request, explicit read errors, and no invented progress percentage.

## Profile and design integration

Preserves the existing Sarabun/Cormorant fonts, LPC palette, compact single-list Profile layout, inline editing, and existing document controls. Import-specific presentation lives in `resume-import.css`; the accepted Profile stylesheet was not rewritten. A matching Experience repeater exposes the already-existing `experience` field and its saved records. Existing design work remains in place.

Importable existing fields: `experience`, `education`, `skills` (including tools), `practiceAreas`, `languages`, `bio`, and explicit `linkedInURL`. No name/email/verification/status/state/years-of-experience changes are generated. About is verbatim résumé summary text and remains unchecked when a current About value exists. A selected scalar replacement is explicit; arrays are additive. Matching employment, education, languages, and skills are skipped. Case, common punctuation and date dashes are normalized for matching. Employment matches by role/employer text and written date range; education matches by school and degree. Ambiguous fuzzy matches are not guessed.

Suggestions are editable and show source text. Missing education details, uncertain proficiency and unrecognized facts stay blank. Five skills and the existing editor collection limits are respected. Existing saved arrays are copied in full for merging, including arrays larger than the normal display limit; no truncation is used to make room for imports.

Apply sends only selected import fields through the existing authenticated, owner-checked, optimistic-concurrency Profile PATCH. It rereads the current profile before saving and checks the selected fields for concurrent changes. A lost save response is reconciled with a read before retrying. Suggestions remain in memory after a failed save and are discarded on cancellation. No draft résumé contents are written to local/session storage or server storage by the importer.

## Processing, retention and approval boundaries

- Parsers: pinned `pdfjs-dist@4.8.69` and `word-extractor@1.0.4`, plus conservative local section rules. PDF.js was installed from the existing local npm cache; the Word parser was installed without running package scripts. No external AI provider is used and no new API key is required. Mozilla’s [Node example](https://github.com/mozilla/pdf.js/blob/master/examples/node/getinfo.mjs) and [API reference](https://mozilla.github.io/pdf.js/api/draft/module-pdfjsLib.html) informed the text-reading implementation.
- The alternate-résumé picker accepts text-based PDF and Word `.doc`/`.docx`; maximum 10 MB. Its visible guidance reads “PDF or DOC, up to 10 MB.” The original plain-text API input remains compatible but is not offered in the picker. PDFs are limited to 15 pages and 100,000 extracted characters. Scanned, encrypted, malformed, unsupported, oversized and unreadable files produce manual-entry/retry states. OCR is not implemented.
- PDF parsing runs in a separate worker with evaluation disabled, a bounded heap and stack, suppressed diagnostics, a 10-second deadline, and cancellation. Document contents are handled as text, never instructions or HTML. Recognized English section headings and blank-line-separated employment/education blocks provide conservative suggestions; complex/multicolumn layouts can require manual correction or yield no suggestions. This is not verified broad-layout AI résumé understanding.
- Extraction routes sit behind LPC’s current authenticated-account, approved-member and paralegal-role checks, plus CSRF, explicit processing consent, owner checks, strict multipart limits, per-account rate limits, capacity reservation before file buffering, and private/no-store responses.
- Temporary copies exist only in request/worker memory and are not persisted. Their references are released after completion/cancellation; this is ordinary memory lifecycle, not a promise of cryptographic RAM erasure. The original submitted résumé keeps its existing storage and retention policy. Existing S3 objects must pass ownership, current-key and existing security-scan checks. Import does not issue S3 writes or deletes.
- Before real-data integration verification: approve an isolated non-production account and document set, storage access, existing storage retention/scanner policy, and the PDF dependency/security review. Live AWS S3 GetObject/tag reads, credentials, scan results and request/bandwidth costs remain unverified. S3 is the existing storage provider, not an AI extraction provider. There is no per-import AI charge in this implementation; normal infrastructure costs still apply.
- Any future AI/OCR provider, document transfer, provider retention policy, API key, model choice, pricing/budget, or paid call needs a separately disclosed and approved integration. The existing shared OpenAI client is not called or repurposed for this feature.

`LPC_RESUME_IMPORT_ENABLED=true` enables the normal route only outside production. Do not enable it against real data without the approval above. The standalone preview supplies only synthetic identity/storage and enables its own local route. It is not a production authentication system.

## Focused verification

Machine-readable results and screenshots are under `output/resume-import-20261015/`.

- Native backend suite: authentication/current role/approval, consent/owner/key protection, no mutation during extraction, transient alternate upload, malformed/unsupported/oversized/binary/empty/scanned files, native guarded Profile save, stale-write protection, scan failure, disabled feature, cancellation, and concurrent request capacity.
- Merge model: repeat-import matching, preservation beyond display limits, excluded account authority fields, explicit scalar selection, empty-value checks and the five-skill limit.
- Browser import matrix: populated and empty profiles, editable suggestions, selected additions, explicit About replacement, unchanged email/status/attachment/years/states, repeat imports, manual/dismiss/Escape behavior, cancellation/late results, unsupported/unreadable files, extraction failure, save failure/retry, concurrent changes, lost save response, keyboard focus, reduced motion, desktop/mobile and dialog accessibility.
- Own-Profile shell integration: first visit from the actual LPC profile route, existing résumé with no second upload, review/save, saved Experience/Education rendering, later access and no automatic replay.
- Existing Profile regression suite: stable geometry during inline editing, validation, retained drafts and photo actions across desktop/mobile Chromium, Firefox and WebKit.
- Additional checks: 320 px rendered inspection without horizontal overflow, source syntax, import module/stylesheet production minification, and the repository frontend API contract check.

Browser preview saves use synthetic in-memory data; own-Profile browser tests use synthetic API projections. Native backend tests use the real authenticated routes and Profile persistence against disposable Mongo, with S3 mocked. Local PDF/text extraction is verified with synthetic documents. Live S3/provider integration, production deployment and whole-product release certification are not established by these focused checks.

Stop for Samantha’s visual and flow review.

Final focused results: **17 backend**, **5 merge-model**, **45 import browser**, **6 own-Profile integration browser**, and **9 existing Profile regression checks passed**. Browser coverage includes Chromium, Firefox and WebKit at desktop and mobile widths. The API contract check passed (492 frontend API literals / 477 mounted route patterns); scoped production minification passed for the three changed/new import-related modules and stylesheet. These are separate focused scopes, not whole-product E2E certification.

2026-10-15 visual review revision: moved the processing/temporary-copy/attachment explanation into a collapsed, keyboard-accessible “How Autofill works” disclosure below the welcome actions. Removed the per-import AI pricing sentence from product copy. Loading and error messages remain visible when needed.

2026-10-15 upload review revision: replaced the visible native file input with a drag-and-drop field, keyboard/click browsing, selected-file feedback, and “PDF or DOC, up to 10 MB.” DOC and DOCX are parsed locally in a bounded worker using [`word-extractor`](https://github.com/morungos/node-word-extractor). Only synthetic Word documents were used. The uploaded résumé attachment is still never replaced by extraction. Word ZIP archives are inspected before parsing: at most 200 entries, 20 MB expanded data, required Word document parts, no encryption or VBA project entries. Existing 10 MB input, 100,000-character, worker-memory and time limits remain. This adds a local software dependency, without a new provider, API key, paid call or document transfer. Its dependency/security review remains part of the existing approval boundary before real-data use. New focused results are in `output/resume-import-dropzone-20261015/`; earlier result counts describe the prior local revision.

Drop-zone revision verification: **21 native backend checks, 51 import/drop-zone browser checks, and 5 merge-model checks passed**. Browser coverage includes desktop/mobile Chromium, Firefox and WebKit, real synthetic DOC/DOCX drops, keyboard browsing, size/type validation and the complete import/review flow. Manual 320 px inspection had no horizontal overflow. API-contract, syntax and scoped minification checks passed. No production deployment or real résumé processing occurred.

## October 17 nonvisual integration

The reviewed backend corrections are now integrated into the active checkout: allocation-driving Word headers are checked before parser allocation, the 25-second admission deadline includes receiving the upload, and parser ownership remains reserved until actual worker exit. The original isolated proofs remain attributed to their source; their earlier failed attempts are preserved.

The 21 affected authenticated route checks pass after integration. Three permanent header/physical-worker-exit controls pass, and a separate additional PDF text-extraction check passes with optional native graphics unavailable. The install-script policy explicitly denies the optional `canvas` build/download script; text extraction does not require that native build. These checks do not establish an operating-system memory sandbox or broad real-document compatibility.

Existing production disablement and the real stored-résumé/scanner/provider boundary remain in force. Current UI, styling and profile refinements stay with Samantha's visual work. No parser rollout, real résumé processing, paid provider operation or whole-product release approval follows from these local results. Evidence: `outputs/lpc-nonvisual-completion-20261017/`.
