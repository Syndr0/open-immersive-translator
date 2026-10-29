# Architecture

## Shared translation boundary

Website paragraphs and document blocks become `{id, text}` segments with source/target language. The server selects an environment-configured provider, protects inline literals, validates identified results and caches compatible successful translations. Provider output remains text; it is never trusted as executable page HTML.

Original source content and translated overlays are stored separately. A document can be translated again without repeating parsing. Job progress records count actual units; cancellation prevents a late job from publishing a newer result. Human translation edits are saved as translated values rather than changing the parsed source.

The Ollama and compatible chat adapters request identified JSON translations from an instruction model. The optional Codex adapter invokes an installed CLI with existing authentication, a structured output schema and isolated temporary working directory; it disables command/browser tools and inherited user configuration. The Google Cloud adapter calls Translation Basic v2 with plain-text arrays. Provider keys stay on the backend.

The opt-in `google-free` adapter independently implements Google's undocumented `translate.googleapis.com/translate_a/t?client=gtx&dt=t&format=html` protocol, using repeated form fields for ordered paragraph batching. This is the no-key alternate Google method observed during the original-extension investigation, rather than its key-bearing browser API or vendor gateway. It is separate from Cloud billing and has no availability guarantee. The adapter escapes literal source HTML and wraps opaque protected identities in its own `code translate="no"` envelopes. Responses are converted back to validated plain text: only exact known token envelopes are removed, unexpected tags are rejected, entities are decoded once, and protected IDs are checked. No provider HTML is inserted into a renderer. A new cache namespace separates this method from earlier plain-text results.

Complete paragraphs remain intact on the primary path. If an envelope/token is damaged, only that paragraph uses bounded prose-fragment recovery; marker-only and punctuation fragments remain local, and original identities/spacing are reassembled without accepting altered markers. Recovery errors are per segment, and a shared rate limit stops remaining recovery groups. Fragment recovery can lose sentence context across inline boundaries; it is a fallback, not a claim of identical translation quality. All adapters pass through the same protected-token validation and provider-scoped cache boundary. Providers translate parsed blocks rather than receiving the original PDF; changing translation providers does not change document recognition or export fidelity.

Providers can declare bounded batch capacity. The broker packs protected chunks across paragraph IDs into actual provider requests, permits two requests concurrently, validates complete response ID sets, and emits cumulative progress as original segments finish. Duplicate text within a request shares work. Cache entries are committed only after a complete original segment validates. Providers without a batching hint retain single-segment behavior. Adapters may return an identified error instead of text for a segment; the broker validates the full ID set and error shape before committing any result, then fails only the affected original block and its aliases. Successful peers remain cacheable, and failed blocks remain retryable. Documents use up to 32 blocks per broker call when the provider supports it, rather than always serializing eight-block groups.

## Website flow

An HTTP/HTTPS content script installs a shadow-DOM Translate control at the right edge of the top-level page. It does not scan prose or contact the translation backend before activation. The launcher asks the background worker to start translation for its own sender tab; the toolbar remains another entry point. The script discovers prose in short tasks, prioritizes visible reading content, and queues up to 32 paragraphs/24,000 characters at a time with a 1,200-pixel reading-ahead margin. Hidden descendants and screen-reader-only labels are excluded from translation input. Code, math and safe inline links remain protected.

The background worker brokers short start/status requests to asynchronous API jobs. Polling happens in the content context so a slow local model does not require a long-lived Manifest V3 worker fetch. Running jobs expose cumulative validated results: completed paragraphs render without waiting for the entire group. Loading feedback is removed as each paragraph finishes. Bilingual translations inherit source typography, color and suitable spacing rather than imposing one heading size or universal border. Original DOM nodes remain intact. Restore removes translations, disconnects translation observation and cancels pending jobs, leaving the idle Translate control available. Source changes, body replacements and new sessions invalidate stale results and clean up cloned overlays.

The initial renderer prioritizes safe bilingual prose translation. It does not traverse shadow roots, claim universal interactive-widget fidelity, or OCR canvas/images. Automatic dynamic handling applies after translation is invoked in the current page context.

## Agent flow

The reader and extension share deliberate, user-triggered setup prompts. The local stdio MCP service wraps the same HTTP API and document store. Uploaded files can be imported from configured local roots or explicit attachment bytes. Bounded document pages expose protected translation inputs. An agent can supply its own translated blocks through the batch-save endpoint, or invoke asynchronous provider jobs. The batch-save route validates every block ID and protected token before committing, keeps source unchanged, merges the translation overlay and cancels pending provider work for that language so late responses cannot overwrite the agent's result. Export paths are unique within a configured directory. See [agent setup and tool contract](agent-service.md).

## Document parsing

Documents become typed blocks: `heading`, `paragraph`, `list` (with its marker), `caption`, `footnote`, `reference`, `table` (a Markdown pipe table), `formula` (LaTeX), `figure` (a stored PNG asset) and `code`. Figures, formulas and code are never sent to a provider. Tables are translated cell by cell; cells holding only names, numbers or math are kept. Every provider request for a document carries its title and abstract as terminology context.

Basic parsing supports text-layer PDF, TXT, Markdown, HTML and DOCX. For PDFs, a layout pass over PDF.js text positions recovers headings (font size and numbering), two-column reading order, lists, captions, footnotes and one block per reference; it rejoins hyphenated words and paragraphs split by page breaks, and drops page numbers, running headers and rotated margin text. It cannot see figures, formulas or table grids. HTML is reduced to safe readable content; importing a document does not execute its scripts.

The optional Python worker runs Docling with table structure, formula-to-LaTeX enrichment and figure extraction, and emits the same typed blocks plus figure PNGs (formulas it cannot read become images). Pages without a text layer are recognized with OCR. Install `workers` requirements in a Python environment and configure:

```dotenv
PARSER=docling
DOCLING_PYTHON=/absolute/path/to/venv/bin/python
```

The worker contract and installation command live beside its source. Parsing models can require substantial downloads and hardware resources. Review their separate licenses. Optional Docling integration does not establish equivalent accuracy to the proprietary recognition backend studied during research.

## Export

HTML and Markdown exports escape untrusted text and include explicit source/translation sections according to the selected mode. Figures are embedded, and HTML formulas are MathML that keeps the LaTeX source. Browser print uses a document-only stylesheet for a reflowed PDF. It cannot preserve original PDF coordinates. Missing/failed translations remain visible as source or are reported; successful output must not silently imply that every segment was translated.

## Local deployment boundary

The API binds to loopback. Provider credentials come from environment variables on the server, never extension settings or page scripts. Browser origins and request hosts are checked. Uploaded files and persistent caches remain in an ignored data directory. A network-hosted multi-user service requires authentication, resource limits, ownership checks and user-separated storage beyond this local deployment.

## Deliberate future work

- Source geometry for layout-preserving PDF output.
- Incremental document revisions and stronger edit-conflict handling.
- Per-site extraction rules authored independently with regression fixtures.
- Accessible translation-only display, richer trusted inline reconstruction and frame coordination.
- A separate coordinate-preserving PDF backend with font and overflow handling.

The research exposed client interfaces and rendering behavior. It did not recover private OCR models, training, production backend code or remote prompts. This implementation uses its own provider prompts and adapters.
