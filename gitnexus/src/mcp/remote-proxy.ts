/**
 * Remote MCP Proxy
 *
 * Bridges a local stdio MCP server to a remote GitNexus HTTP service.
 * The local Claude/Cursor process speaks stdio MCP to this proxy,
 * which forwards all tool calls, resource reads, and prompt requests
 * to the remote GitNexus `serve` instance via StreamableHTTP.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ReadResourceRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { CompatibleStdioServerTransport } from './compatible-stdio-transport.js';
import { realStdoutWrite } from './core/lbug-adapter.js';
import { createRequire } from 'node:module';

/**
 * Start the remote proxy: stdio server ↔ StreamableHTTP client.
 *
 * @param remoteUrl - Full URL to the remote GitNexus service
 *                    (e.g. "https://codemem.hawkingrad.com?token=xxx")
 *                    The `/api/mcp` path is appended automatically.
 */
export async function startRemoteProxy(remoteUrl: string): Promise<void> {
  const require = createRequire(import.meta.url);
  const pkgVersion: string = require('../../package.json').version;

  // --- graceful shutdown (registered early so stdio-close during connect is caught) ---
  let upstream: Client | undefined; // eslint-disable-line prefer-const -- assigned after shutdown wiring
  let server: Server | undefined; // eslint-disable-line prefer-const
  let shuttingDown = false;
  const shutdown = (exitCode = 0) => {
    if (shuttingDown) return;
    shuttingDown = true;
    const cleanup = async () => {
      try {
        await upstream?.close();
      } catch {}
      try {
        await server?.close();
      } catch {}
      process.exit(exitCode);
    };
    cleanup().catch(() => process.exit(exitCode));
  };

  const safeStderrWrite = (msg: string) => {
    if (shuttingDown) return;
    try {
      process.stderr.write(msg);
    } catch {}
  };

  process.on('SIGINT', () => shutdown());
  process.on('SIGTERM', () => shutdown());
  process.on('uncaughtException', (err) => {
    safeStderrWrite(`GitNexus MCP (remote) uncaughtException: ${err?.stack || err}\n`);
    shutdown(1);
  });
  process.on('unhandledRejection', (reason: any) => {
    safeStderrWrite(`GitNexus MCP (remote) unhandledRejection: ${reason?.stack || reason}\n`);
  });
  process.stdin.on('end', () => shutdown());
  process.stdin.on('error', () => shutdown());
  process.stdout.on('error', () => shutdown());
  process.stderr.on('error', () => shutdown());

  // --- upstream: connect to remote GitNexus via StreamableHTTP ---
  const base = remoteUrl.replace(/\/+$/, '');
  const mcpUrl = new URL(`${base}/api/mcp`);

  const authToken = process.env.GITNEXUS_REMOTE_TOKEN;
  if (authToken && !mcpUrl.searchParams.has('token')) {
    mcpUrl.searchParams.set('token', authToken);
  }

  console.error(`GitNexus: connecting to remote service at ${mcpUrl.origin}${mcpUrl.pathname}`);

  upstream = new Client({ name: 'gitnexus-remote-proxy', version: pkgVersion });
  const transport = new StreamableHTTPClientTransport(mcpUrl);
  await upstream.connect(transport);
  console.error('GitNexus: remote connection established');

  // --- tool whitelist ---
  const ALLOWED_TOOLS = new Set(
    (process.env.GITNEXUS_REMOTE_TOOLS ?? 'list_repos,query,context,cypher,impact').split(','),
  );

  // --- downstream: stdio server exposed to Claude/Cursor ---
  server = new Server(
    { name: 'gitnexus', version: pkgVersion },
    { capabilities: { tools: {}, resources: {}, prompts: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const result = await upstream!.listTools();
    const filtered = result.tools.filter((t) => ALLOWED_TOOLS.has(t.name));
    console.error(
      `GitNexus: exposing ${filtered.length}/${result.tools.length} tools: ${filtered.map((t) => t.name).join(', ')}`,
    );
    return { tools: filtered };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    if (!ALLOWED_TOOLS.has(name)) {
      throw new Error(
        `Tool "${name}" is not available in remote mode. Available: ${[...ALLOWED_TOOLS].join(', ')}`,
      );
    }
    console.error(`GitNexus: remote tool call → ${name}`);
    try {
      const result = await upstream!.callTool({ name, arguments: args ?? {} });
      console.error(`GitNexus: remote tool call ← ${name} (ok)`);
      return { content: result.content };
    } catch (err: any) {
      console.error(`GitNexus: remote tool call ← ${name} (error: ${err.message})`);
      throw err;
    }
  });

  server.setRequestHandler(ListResourcesRequestSchema, async () => {
    const result = await upstream!.listResources();
    return { resources: result.resources };
  });

  server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => {
    const result = await upstream!.listResourceTemplates();
    return { resourceTemplates: result.resourceTemplates };
  });

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const { uri } = request.params;
    const result = await upstream!.readResource({ uri });
    return { contents: result.contents };
  });

  server.setRequestHandler(ListPromptsRequestSchema, async () => {
    const result = await upstream!.listPrompts();
    return { prompts: result.prompts };
  });

  server.setRequestHandler(GetPromptRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const result = await upstream!.getPrompt({ name, arguments: args });
    return { messages: result.messages };
  });

  // --- stdio transport (same safe-stdout approach as local mode) ---
  const _safeStdout = new Proxy(process.stdout, {
    get(target, prop, receiver) {
      if (prop === 'write') return realStdoutWrite;
      const val = Reflect.get(target, prop, receiver);
      return typeof val === 'function' ? val.bind(target) : val;
    },
  });
  const stdioTransport = new CompatibleStdioServerTransport(process.stdin, _safeStdout);
  await server.connect(stdioTransport);
}
