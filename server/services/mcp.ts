import fs from 'fs';
import path from 'path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

let mcpLinkedinClient: Client | null = null;

export async function initMcpClients() {
  try {
    const isWin = process.platform === 'win32';
    const profilePath = path.join(process.cwd(), '.apex-data', 'linkedin-profile');
    
    // Try to find mcp-server-linkedin executable. If it's not in the system PATH, 
    // fallback to the common pipx/uv installation path used by Antigravity.
    let mcpCommand = isWin ? 'mcp-server-linkedin.exe' : 'mcp-server-linkedin';
    const fallbackPath = path.join(process.env.USERPROFILE || process.env.HOME || '', '.local', 'bin', mcpCommand);
    
    if (fs.existsSync(fallbackPath)) {
      mcpCommand = fallbackPath;
    }

    const transport = new StdioClientTransport({
      command: mcpCommand,
      args: ['--user-data-dir', profilePath]
    });

    const client = new Client(
      { name: 'apex-crm-backend', version: '1.0.0' },
      { capabilities: {} }
    );

    await client.connect(transport);
    mcpLinkedinClient = client;
    console.log('[MCP] Connected to standalone LinkedIn MCP server.');
    console.log(`[MCP] Using local session profile: ${profilePath}`);
  } catch (err) {
    console.error('[MCP] Failed to connect to LinkedIn MCP server. Make sure it is installed (npm run install:mcp):', err);
  }
}

export function getMcpClient() {
  return mcpLinkedinClient;
}
