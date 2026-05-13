/**
 * Simple MCP server for testing ListMcpResourcesTool
 *
 * Provides 3 static resources:
 * - test://resource/hello — Hello World text
 * - test://resource/config — JSON config
 * - test://resource/readme — README text
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const server = new McpServer({
  name: 'test-mcp-server',
  version: '1.0.0',
});

// Register 3 resources
server.resource(
  'hello',
  'test://resource/hello',
  { description: 'A simple hello world resource', mimeType: 'text/plain' },
  async (uri) => ({
    contents: [{ uri: uri.href, text: 'Hello World from MCP!', mimeType: 'text/plain' }],
  }),
);

server.resource(
  'config',
  'test://resource/config',
  { description: 'Test configuration JSON', mimeType: 'application/json' },
  async (uri) => ({
    contents: [{ uri: uri.href, text: JSON.stringify({ name: 'test-config', version: '1.0.0', debug: true }), mimeType: 'application/json' }],
  }),
);

server.resource(
  'readme',
  'test://resource/readme',
  { description: 'Test README document', mimeType: 'text/markdown' },
  async (uri) => ({
    contents: [{ uri: uri.href, text: '# Test MCP Server\n\nThis is a test README.', mimeType: 'text/markdown' }],
  }),
);

// Also register a simple tool so the server is fully functional
server.tool(
  'echo',
  'Echo back the input message',
  { message: z.string().describe('Message to echo') },
  async ({ message }) => ({
    content: [{ type: 'text', text: `Echo: ${message}` }],
  }),
);

// Start the server
const transport = new StdioServerTransport();
await server.connect(transport);
