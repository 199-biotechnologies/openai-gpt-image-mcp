#!/usr/bin/env node

const { spawn } = require('child_process');
const { join } = require('path');

const args = process.argv.slice(2);

if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
  console.log(`
OpenAI GPT Image MCP Server

Usage:
  npx @199-biotechnologies/openai-gpt-image-mcp

This will start the MCP server. Make sure to set your OPENAI_API_KEY environment variable.

For MCP client configuration, use:
  {
    "command": "npx",
    "args": ["@199-biotechnologies/openai-gpt-image-mcp"],
    "env": {
      "OPENAI_API_KEY": "your-api-key-here"
    }
  }
`);
  process.exit(0);
}

// Start the MCP server
const serverPath = join(__dirname, 'index.js');
const mcp = spawn('node', [serverPath], {
  stdio: 'inherit',
  env: { ...process.env }
});

mcp.on('error', (err) => {
  console.error('Failed to start MCP server:', err);
  process.exit(1);
});

mcp.on('exit', (code) => {
  process.exit(code || 0);
});