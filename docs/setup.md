# Setup and technical reference

**Bilingual websites and documents, using a translation provider you choose.**

An independent, MIT-licensed implementation of paragraph-based website translation and a reflowed document translation workspace. A Chrome extension and a document reader share one local translation backend. The implementation follows the architecture established during a browser-artifact investigation; it contains original code and uses no Immersive Translate service, proprietary source, branding or rule database.

## What works

- **Websites:** use a right-side Translate/Restore control, show completed paragraphs progressively in the page's typography, retain the original page, and handle newly inserted content.
- **Interface:** switch between Chinese and English with the **中 / EN** control. Your choice is saved separately from the document translation language.
- **Agent help:** select **Copy for your agent** for guided website/provider setup, or attach a document to your agent and get bilingual files back through the local MCP service. The agent can supply translations using its own model without a separate translation API key.
- **Documents:** import text PDFs, DOCX, HTML, Markdown and TXT; translate blocks; edit translations; export bilingual HTML/Markdown or print to PDF.
- **Providers:** free Google web translation without a key, Google Cloud Translation, local Ollama, an installed Codex CLI, or a compatible chat-completion endpoint. Provider credentials stay in the backend environment.
- **Shared core:** protected code/math/link tokens, identified results, bounded requests, caching and explicit per-segment failures.
- **Papers:** with the Docling worker, PDFs keep their figures (as images), formulas (LaTeX, rendered with KaTeX), tables (each cell translated beside its source), lists, captions, footnotes and references. The built-in parser needs no Python: it recovers headings, lists, captions and references from the text layer, but not figures, formulas or table grids.

Documents are reflowed into a bilingual reading view, not redrawn at the original PDF coordinates. Parser and translation quality depend on the chosen engines; for papers, an LLM provider (Codex or a 7B+ local model) handles terminology better than the free Google endpoint. See [architecture and limits](architecture.md).

## Start with your agent

In the reader, choose **Website translation → Copy for your agent**, then paste the request into Codex or another coding agent. Your agent handles installation, starts the service and prepares the extension. The command-line instructions below remain available for manual setup.

For documents, attach your file to the agent and ask: **“Use Open Immersive Translator to translate this into Chinese and show me the bilingual output.”** The reader's document-agent request also includes the current file and target language. See the [agent service setup and workflow](agent-service.md).

## Quick start

Requirements: Node.js **22.22.2+**, npm, and access to a translation provider. A local language model is optional.

```sh
git clone https://github.com/Syndr0/open-immersive-translator.git
cd open-immersive-translator
npm ci
cp -n .env.example .env
```

The example configuration selects the free, unofficial Google web endpoint. Source text is sent to Google when you translate; no key or billing setup is needed. See its availability limits below. Start the app:

```sh
npm run dev
```

For offline translation, set `TRANSLATION_PROVIDER=ollama`, install [Ollama](https://ollama.com/) and run `ollama pull qwen3.5:2b` before starting the app. A 7B or larger model is not required. For a smaller download, try `ollama pull qwen3.5:0.8b` and set `OLLAMA_MODEL=qwen3.5:0.8b` in `.env`. Available memory, context length and hardware affect speed and memory use. Smaller models can make more translation or structured-output errors, especially with technical documents. These are setup options, not benchmarked translation-quality recommendations. [Qwen3.5 model catalog](https://ollama.com/library/qwen3.5).

Open **http://127.0.0.1:5173** for the document workspace. The API listens on **http://127.0.0.1:8787**. Choose a target language, import a file and select Translate. Your selected provider must be available for actual translation; there is no silent mock fallback.

For a single-server build:

```sh
npm run build
npm start
```

Open **http://127.0.0.1:8787**. Keep the repository dependencies installed: the API runs TypeScript through `tsx`.

### Free translation without a model or API key

Set this backend value in `.env`, then restart the API:

```dotenv
TRANSLATION_PROVIDER=google-free
```

This opt-in adapter uses Google's **unofficial HTML translation web endpoint** (`translate.googleapis.com/translate_a/t`, `client=gtx`, `format=html`). It needs no account, API key, model download or billing setup. It batches up to 32 strings within a conservative 12,000-source-character budget. These are this application's bounds, not a published Google quota. Both documents and the extension use it through the same local backend.

Complete paragraphs travel together: protected identities use small `translate="no"` envelopes, while literal source markup is escaped. The adapter removes only its known envelopes, rejects unexpected tags, decodes text once and validates every protected token before local restoration. Provider HTML is never inserted into the page. A changed token or invalid envelope triggers recovery only for the affected paragraph; valid peers are retained. Fragment recovery can reduce fluency around inline formatting, so it remains a fallback. The HTML method has its own cache namespace so earlier plain-text results are not reused.

This endpoint is undocumented: availability and rate limits can change, and it is not a guaranteed, unlimited free API. Throttling and failures are reported; the app never falls back to Codex or a paid provider. For a supported API, configure Google Cloud below or another provider you control.

### Use your existing Codex sign-in

If Codex is already installed and signed in, it can handle both the document Translate button and website translation using your account's existing allowance. Set these backend values and restart the API:

```dotenv
TRANSLATION_PROVIDER=codex
CODEX_CLI_PATH=codex
CODEX_MODEL=gpt-6.1-sol
```

Use an absolute `CODEX_CLI_PATH` if the desktop app cannot find `codex` on its PATH. The adapter uses the official CLI's saved authentication without reading or copying tokens. Each bounded translation runs in an isolated temporary directory with command/browser tools disabled, read-only sandboxing, no inherited user configuration, and a structured JSON output schema. No separate API key or model download is needed. Account limits and model availability still apply; this is not unlimited free inference. [Official non-interactive Codex documentation](https://developers.openai.com/codex/noninteractive).

### Use Google Translate without a local model

Use [Google Cloud Translation Basic](https://docs.cloud.google.com/translate/docs/setup): select a Cloud project, enable billing and the Cloud Translation API, then create an API key. Restrict the key to the Cloud Translation API. Set these values in your server's `.env` and restart the backend:

```dotenv
TRANSLATION_PROVIDER=google
GOOGLE_TRANSLATE_API_KEY=your-api-key
```

Google translates extracted website paragraphs and document blocks using its hosted NMT service. No Ollama installation or local model is needed. This uses the official Cloud API, which has its own [usage pricing](https://cloud.google.com/translate/pricing); a consumer Google Translate account is not an API credential. The key stays on the backend. Source text is sent to Google when you translate. PDF recognition and reflowed export still use this project's document pipeline.

### Use a compatible model API

Set these values in `.env`, then restart the backend:

```dotenv
TRANSLATION_PROVIDER=compatible
COMPATIBLE_BASE_URL=http://127.0.0.1:1234/v1
COMPATIBLE_MODEL=your-model
COMPATIBLE_API_KEY=
```

The compatible adapter sends chat-completion requests and expects JSON containing identified translations. Configure a model that can reliably follow structured instructions. The API key is optional for local servers and required when your chosen provider requires one. Only send documents/page text to a provider you intend to use.

### Install the Chrome extension

1. Run `npm run build` and keep the API running.
2. Open `chrome://extensions`, enable **Developer mode**, and select **Load unpacked**.
3. Choose this repository's **`apps/extension/dist`** folder.
4. Open or refresh a normal website and click **Translate** on its right edge. Use the extension popup to choose a language.
5. Use **Restore original page** to remove the bilingual additions; the Translate control remains available. The extension's backend and Document app both default to `http://127.0.0.1:8787`. If you use the separate development reader, change Document app to `http://127.0.0.1:5173` in extension settings.

After rebuilding an installed unpacked extension, click **Reload** on its card in `chrome://extensions`, accept any new site-access prompt, then refresh the website.

The extension installs its control on HTTP/HTTPS pages and requests site access for that purpose. It scans and submits text only after you choose Translate. Browser-internal pages, inaccessible frames, shadow-root content and canvas/image-only text require further integrations. Website text is sent to your configured backend/provider when you translate.

### Optional Docling parser

The Python worker is optional and separate from the Node installation, but recommended for papers. Follow the [Docling worker setup](../workers/docling/README.md), set `PARSER=docling` and point `DOCLING_PYTHON` at that environment's Python (relative paths resolve from the repository root). See [document parsing](architecture.md#document-parsing). Model downloads may be needed on the first run. Code and model licenses are separate; select and pin the models for your deployment.

## Develop and verify

```sh
npm run verify                 # TypeScript, unit/integration tests, app/extension builds
npx playwright install chromium
npm run test:e2e               # browser workflow with an explicit test provider
```

Tests use an explicitly selected deterministic demo/fake provider. Demo output is labeled and is not evidence of machine-translation quality. The example configuration selects `google-free`; with no provider setting, the code falls back to Ollama. Review real translations with your selected provider before relying on them.

```text
apps/reader       React document workspace
apps/extension    Manifest V3 Chrome extension
services/api      Local upload, parse, job, edit and export API
services/agent    Local MCP document tools for coding agents
packages/core     Shared broker, provider adapters and cache
packages/agent-prompts Shared Chinese/English requests copied by reader and extension
workers           Optional document recognition adapter
tests             Browser integration tests
```

Runtime documents, translation caches and credentials are ignored by Git. Do not commit `.env`, `.data`, personal documents or provider keys. The local API is designed for a single-user loopback deployment; adding remote hosting needs authentication and per-user isolation.

## Design background

The important discovery was the separation between recognition, translation and rendering:

```text
Website DOM ────────────────┐
                           ├─ protected segments → shared broker → provider
Document → parser → blocks ┘                           ↓
                                 bilingual DOM / document → export
```

The source product's PDF Pro client consumes Mathpix Markdown and prints a reflowed HTML view. This project uses replaceable parsing and independent interfaces rather than calling its private endpoints. Coordinate-preserving PDF output, sophisticated table/figure recovery and broad per-site rules remain future work.

See [architecture](architecture.md), [contributing](../CONTRIBUTING.md), and [license](../LICENSE). This project is not affiliated with Immersive Translate or Mathpix.
