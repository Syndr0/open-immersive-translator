#!/usr/bin/env node
import { config } from 'dotenv';
import { fileURLToPath } from 'node:url';
import { tsImport } from 'tsx/esm/api';

// Resolve dependencies and configuration beside this launcher, regardless of the
// MCP client's working directory. Keep stdout reserved for the MCP protocol.
config({ path: fileURLToPath(new URL('../.env', import.meta.url)), quiet: true });
await tsImport('../services/agent/src/index.ts', import.meta.url);
