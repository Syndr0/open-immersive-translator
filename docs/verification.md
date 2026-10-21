# Initial verification

Version: 0.1.0. Local checks performed during implementation:

- TypeScript strict checking and production reader/extension builds passed.
- Unit/integration tests passed: inline protection, original DOM identity/restoration, dynamic changes, source-version guards, short-job transport/cancellation, provider HTTP contracts, cache identity, queued cancellation, document import/edit/persistence and partial export policy.
- Six Chromium browser tests passed: document import/translation/edit/reload/HTML export, responsive mobile controls, the built website content script connected to the API with original restoration, interface language persistence, mobile language switching, and preservation of document content/target/translations/unsaved edits while changing interface language.
- The website browser test emulates Chrome's message transport. It executes the actual built content script, DOM observers and backend; it is not a complete native Chrome toolbar/permission installation test.
- A local text-extraction check of the supplied 15-page scientific PDF produced 63 blocks and 51,337 characters. This verifies basic extraction, not reading-order accuracy, formula recovery or OCR.
- Desktop and mobile layouts were visually inspected. The README screenshot shows the actual built app.

Deterministic providers are explicitly selected for automated tests. Real Ollama/compatible wire formats are tested against local HTTP fixtures; no running model was available for translation-quality assessment. The optional Docling model pipeline was not installed/executed in these lightweight checks.

Known dependency-audit result at creation: three moderate advisories follow Mammoth's CLI-only `argparse` → `sprintf-js` dependency chain. This application calls Mammoth's text-extraction library and does not run its CLI. No patched upstream version was available from the registry at inspection. Track upstream rather than downgrading the parser to an obsolete version. The current PDF.js dependency is beyond the reported vulnerable range.

Run the commands in the main README to reproduce checks. Job metadata is session-local; parsed documents, translations and cache persist across backend restarts. Complex PDF layout, DOCX formatting/images and shadow-root website content remain outside the initial fidelity scope.
