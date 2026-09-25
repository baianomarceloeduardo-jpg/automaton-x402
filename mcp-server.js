#!/usr/bin/env node
'use strict';
// Kept for existing MCP client configs pointing at this path. The MCP server now ships in the
// npm package (npx -y @celorodrigues/x402-conformance --mcp); this runs the same code.
require('./packages/x402-conformance/mcp-server.js');
