import { serveStdio, StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { loadConfig } from './config.ts';
import { createAgentServer } from './server.ts';

// stdout belongs exclusively to MCP JSON-RPC. Report setup/transport failures on stderr.
try {
  const config = loadConfig();
  const handle = serveStdio(() => createAgentServer(config), {
    transport: new StdioServerTransport(undefined, undefined, { maxBufferSize: 40 * 1024 * 1024 }),
    onerror: error => { console.error(`Open Immersive Translator MCP: ${error.message}`); },
  });
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { void handle.close().finally(() => { process.exitCode = 0; }); });
} catch (error) {
  console.error(`Open Immersive Translator MCP setup failed: ${error instanceof Error ? error.message : 'Invalid local configuration.'}`);
  process.exitCode = 1;
}
