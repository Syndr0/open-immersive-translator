# Architecture

## Shared translation boundary

Website paragraphs and document blocks become `{id, text}` segments with source/target language. The server selects an environment-configured provider, protects inline literals, validates identified results and caches compatible successful translations. Provider output remains text; it is never trusted as executable page HTML.

Original source content and translated overlays are stored separately. A document can be translated again without repeating parsing. Job progress records count actual units; cancellation prevents a late job from publishing a newer result. Human translation edits are saved as translated values rather than changing the parsed source.

## Website flow

The popup invokes a content script on the active page. The script finds prose roots, excludes code, editable controls, math and its own nodes, and batches eligible paragraphs. The background worker brokers short start/status requests to asynchronous API jobs. Polling happens in the content context so a slow local model does not require a long-lived Manifest V3 worker fetch. Bilingual translations are inserted as owned adjacent nodes, leaving original DOM nodes intact. Restoration removes owned translations, disconnects observation and cancels pending jobs. Source changes and new sessions invalidate pending results.

The initial renderer prioritizes safe bilingual prose translation. It does not traverse shadow roots, claim universal interactive-widget fidelity, or OCR canvas/images. Automatic dynamic handling applies after translation is invoked in the current page context.

## Document parsing

Basic parsing supports text-layer PDF, TXT, Markdown, HTML and DOCX. PDF.js provides page text extraction. This is a lightweight reading-order heuristic, not recognition of every table, formula or scientific column. Scanned pages without text need an OCR-capable adapter. HTML is reduced to safe readable content; importing a document does not execute its scripts.

The optional Python worker uses Docling's `DocumentConverter` and normalizes Markdown into the same block interface. Install `workers` requirements in a Python environment and configure:

```dotenv
PARSER=docling
DOCLING_PYTHON=/absolute/path/to/venv/bin/python
```

The worker contract and installation command live beside its source. Parsing models can require substantial downloads and hardware resources. Review their separate licenses. Optional Docling integration does not establish equivalent accuracy to the proprietary recognition backend studied during research.

## Export

HTML and Markdown exports escape untrusted text and include explicit source/translation sections according to the selected mode. Browser print uses a document-only stylesheet for a reflowed PDF. It cannot preserve original PDF coordinates. Missing/failed translations remain visible as source or are reported; successful output must not silently imply that every segment was translated.

## Local deployment boundary

The API binds to loopback. Provider credentials come from environment variables on the server, never extension settings or page scripts. Browser origins and request hosts are checked. Uploaded files and persistent caches remain in an ignored data directory. A network-hosted multi-user service requires authentication, resource limits, ownership checks and user-separated storage beyond this local deployment.

## Deliberate future work

- Richer parser-neutral tables, captions, assets, source geometry and equation representations.
- Incremental document revisions and stronger edit-conflict handling.
- Per-site extraction rules authored independently with regression fixtures.
- Accessible translation-only display, richer trusted inline reconstruction and frame coordination.
- A separate coordinate-preserving PDF backend with font and overflow handling.

The research exposed client interfaces and rendering behavior. It did not recover private OCR models, training, production backend code or remote prompts. This implementation uses its own provider prompts and adapters.
