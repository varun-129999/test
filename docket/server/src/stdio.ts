#!/usr/bin/env node
// Local stdio MCP for Claude Code or Claude Desktop. Uses the same database as the HTTP server.
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { openStore } from './config.js';
import { createMcpServer } from './tools.js';

const server = createMcpServer(openStore().store);
await server.connect(new StdioServerTransport());
