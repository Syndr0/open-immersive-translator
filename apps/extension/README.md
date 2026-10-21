# Chrome extension

Build from the repository root with `npm run build --workspace @oit/extension`. In Chrome, open `chrome://extensions`, enable **Developer mode**, choose **Load unpacked**, and select `apps/extension/dist`.

Start the local API and document reader using the root setup instructions. Click this extension on a normal website, choose a language, then **Translate this page**. **Restore original** removes only extension-owned translation nodes. The original text, links and event handlers remain in place.

The extension requests `activeTab`, `scripting` and `storage`, plus HTTP access to `localhost`/`127.0.0.1` for your local API. It does not request permanent access to all websites. Provider keys belong on the API server. Settings can change local API/reader ports, source/target language and bilingual theme.

Paragraphs near the viewport are queued in bounded batches. Newly inserted or edited content is reconsidered after a short quiet period. Rich inline tags use a restricted identity-token grammar; code, equations and images remain local protected elements. Provider HTML is never inserted as HTML. Invalid responses show a small unavailable indicator while leaving source readable.

Translation uses server jobs and short polling requests. Slow local-model inference does not hold a Manifest V3 service worker fetch open. Restoring/restarting the page aborts polling and cancels the current server job; a session generation also prevents late results from entering the DOM.

This release supports bilingual mode only. Chrome internal pages, the Web Store, built-in PDF views, shadow-root contents and frames without active-tab permission are outside this DOM translator. Reloading or navigating clears translation and requires another user action. It does not translate image-only/canvas text. For PDFs and other files, use the document app. For the production server (`npm start`), change **Settings → Document app** to `http://127.0.0.1:8787`.

Tests cover paragraph grouping, exclusions, safe rich rendering, marker validation, restoration, stale pending responses, host edits and dynamic insertion without self-triggered translation loops.
