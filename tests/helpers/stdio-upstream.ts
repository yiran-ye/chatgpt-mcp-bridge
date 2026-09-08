import { appendFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { fixtureServer } from './upstream-server.js';

const marker = process.env['MCP_TEST_START_MARKER'];
if (marker) appendFileSync(marker, `${process.pid}\n`);
if (process.env['MCP_TEST_STDERR_SECRET']) process.stderr.write(process.env['MCP_TEST_STDERR_SECRET']);
if (process.env['MCP_TEST_CHILD_MARKER']) {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  writeFileSync(process.env['MCP_TEST_CHILD_MARKER'], String(child.pid));
}
if (process.env['MCP_TEST_STALL']) {
  setInterval(() => {}, 1000);
} else {
  const server = fixtureServer({ calls: [], cancelled: 0, requests: 0, ...(process.env['MCP_TEST_MODE'] ? { mode: process.env['MCP_TEST_MODE'] } : {}) });
  await server.connect(new StdioServerTransport());
}
