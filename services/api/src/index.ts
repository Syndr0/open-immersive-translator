import { config } from 'dotenv';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.ts';

// npm workspace scripts run with services/api as cwd; configuration lives at root.
config({ path: fileURLToPath(new URL('../../../.env', import.meta.url)), quiet: true });
const { app, close } = await createApp();
const port = Number(process.env.PORT || 8787);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be between 1 and 65535');
const server = app.listen(port, '127.0.0.1', () => console.log(`Open Immersive Translator: http://127.0.0.1:${port}`));
for (const signal of ['SIGTERM', 'SIGINT'] as const) process.once(signal, () => {
  close();
  server.close(() => process.exit(0));
  // Polling clients hold keep-alive sockets; do not let them block shutdown.
  server.closeIdleConnections();
  setTimeout(() => process.exit(0), 5_000).unref();
});
