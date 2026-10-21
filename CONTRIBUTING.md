# Contributing

Use Node 22.22.2 or newer. Run `npm ci`, copy `.env.example` to `.env`, and configure your own translation provider. `npm run dev` starts the local API and reader. Build the extension with `npm run build` and load `apps/extension/dist` in Chrome.

Before opening a pull request, run `npm run verify` and `npm run test:e2e` after installing Playwright Chromium. Add fixtures that exercise meaningful behavior: protected-token failures, provider errors, stale responses, DOM restoration, import/export and cancellation. Tests should not require paid provider calls.

Keep provider secrets on the backend. Do not add private service endpoints, vendor source/rule dumps, user documents, model weights or generated translation caches. Use original or suitably licensed fixtures. Record parser/model versions when reporting recognition failures.

For translation-quality reports, include source/target languages, selected provider/model, a short non-sensitive example, expected meaning and actual output. Separate parser errors from translation errors and export layout issues.
