/**
 * MCP Command
 *
 * Starts the MCP server in standalone mode.
 *
 * Local mode (default): Loads all indexed repos from the global registry.
 * Remote mode (--remote <url>): Proxies tool calls to a remote GitNexus service.
 */

import { startMCPServer } from '../mcp/server.js';
import type { Backend } from '../mcp/backend.js';

export const mcpCommand = async (options?: { remote?: string }) => {
  // Prevent unhandled errors from crashing the MCP server process.
  // LadybugDB lock conflicts and transient errors should degrade gracefully.
  process.on('uncaughtException', (err) => {
    console.error(`GitNexus MCP: uncaught exception — ${err.message}`);
    // Process is in an undefined state after uncaughtException — exit after flushing
    setTimeout(() => process.exit(1), 100);
  });
  process.on('unhandledRejection', (reason) => {
    const msg = reason instanceof Error ? reason.message : String(reason);
    console.error(`GitNexus MCP: unhandled rejection — ${msg}`);
  });

  // Determine backend: remote service or local index
  const serverUrl = options?.remote || process.env.GITNEXUS_SERVER_URL;
  let backend: Backend;

  if (serverUrl) {
    // Remote mode — proxy to a GitNexus service
    const { RemoteBackend } = await import('../mcp/remote/remote-backend.js');
    backend = new RemoteBackend(serverUrl);
    try {
      await backend.init();
    } catch (err: any) {
      console.error(
        `GitNexus: Failed to connect to remote service at ${serverUrl}: ${err.message}`,
      );
      process.exit(1);
    }
    const repos = await backend.listRepos();
    console.error(
      `GitNexus: Connected to remote service at ${serverUrl} — ${repos.length} repo(s): ${repos.map((r) => r.name).join(', ')}`,
    );
  } else {
    // Local mode — load from global registry
    const { LocalBackend } = await import('../mcp/local/local-backend.js');
    backend = new LocalBackend();
    await backend.init();

    const repos = await backend.listRepos();
    if (repos.length === 0) {
      console.error(
        'GitNexus: No indexed repos yet. Run `gitnexus analyze` in a git repo — the server will pick it up automatically.',
      );
    } else {
      console.error(
        `GitNexus: MCP server starting with ${repos.length} repo(s): ${repos.map((r) => r.name).join(', ')}`,
      );
    }
  }

  // Start MCP server (serves all repos via chosen backend)
  await startMCPServer(backend);
};
