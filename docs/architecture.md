# Architecture

## Shared translation boundary

Website paragraphs and document blocks become `{id, text}` segments with source/target language. The server selects an environment-configured provider, protects inline literals, validates identified results and caches compatible successful translations. Provider output remains text; it is never trusted as executable page HTML.

Original source content and translated overlays are stored separately. A document can be translated again without repeating parsing. Job progress records count actual units; cancellation prevents a late job from publishing a newer result. Human translation edits are saved as translated values rather than changing the parsed source.

The Ollama and compatible chat adapters request identified JSON translations from an instruction model. The Google adapter calls Cloud Translation Basic v2 with plain-text arrays and maps ordered responses back to segment IDs; it needs no local model. Credentials stay in server environment variables. All adapters pass through the same protected-token validation and cache boundary. Google translates parsed blocks rather than receiving the original PDF; changing translation providers does not change document recognition or export fidelity.

## Website flow

The popup invokes a content script on the active page. The script finds prose roots, excludes code, editable controls, math and its own nodes, and batches eligible paragraphs. The background worker brokers short start/status requests to asynchronous API jobs. Polling happens in the content context so a slow local model does not require a long-lived Manifest V3 worker fetch. Bilingual translations are inserted as owned adjacent nodes, leaving original DOM nodes intact. Restoration removes owned translations, disconnects observation and cancels pending jobs. Source changes and new sessions invalidate pending results.

The initial renderer prioritizes safe bilingual prose translation. It does not traverse shadow roots, claim universal interactive-widget fidelity, or OCR canvas/images. Automatic dynamic handling applies after translation is invoked in the current page context.

## Agent flow

The reader and extension share deliberate, user-triggered setup prompts. The local stdio MCP service wraps the same HTTP API and document store. Uploaded files can be imported from configured local roots or explicit attachment bytes. Bounded document pages expose protected translation inputs. An agent can supply its own translated blocks through the batch-save endpoint, or invoke asynchronous provider jobs. The batch-save route validates every block ID and protected token before committing, keeps source unchanged, merges the translation overlay and cancels pending provider work for that language so late responses cannot overwrite the agent's result. Export paths are unique within a configured directory. See [agent setup and tool contract](agent-service.md).

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
