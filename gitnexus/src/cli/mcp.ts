/**
 * MCP Command
 *
 * Starts the MCP server in standalone mode.
 * Loads all indexed repos from the global registry.
 * No longer depends on cwd — works from any directory.
 *
 * With --remote <url>, runs as a thin proxy that forwards all MCP
 * requests to a remote GitNexus HTTP service via StreamableHTTP.
 */

import { startMCPServer } from '../mcp/server.js';
import { LocalBackend } from '../mcp/local/local-backend.js';

export const mcpCommand = async (options?: { remote?: string }) => {
  // --remote mode: proxy to a remote GitNexus service
  if (options?.remote) {
    const { startRemoteProxy } = await import('../mcp/remote-proxy.js');
    await startRemoteProxy(options.remote);
    return;
  }

  // --- early shutdown wiring (before any async work) ---
  let shuttingDown = false;
  const shutdown = (exitCode = 0) => {
    if (shuttingDown) return;
    shuttingDown = true;
    process.exit(exitCode);
  };

  const safeStderrWrite = (msg: string) => {
    if (shuttingDown) return;
    try {
      process.stderr.write(msg);
    } catch {}
  };

  process.on('uncaughtException', (err) => {
    safeStderrWrite(`GitNexus MCP: uncaught exception — ${err.message}\n`);
    shutdown(1);
  });
  process.on('unhandledRejection', (reason) => {
    const msg = reason instanceof Error ? reason.message : String(reason);
    safeStderrWrite(`GitNexus MCP: unhandled rejection — ${msg}\n`);
  });
  process.stdin.on('end', () => shutdown());
  process.stdin.on('error', () => shutdown());
  process.stdout.on('error', () => shutdown());
  process.stderr.on('error', () => shutdown());

  // Initialize multi-repo backend from registry.
  // The server starts even with 0 repos — tools call refreshRepos() lazily,
  // so repos indexed after the server starts are discovered automatically.
  const backend = new LocalBackend();
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

  // Start MCP server (serves all repos, discovers new ones lazily)
  await startMCPServer(backend);
};
