/**
 * HTTP API Server
 *
 * REST API for browser-based clients to query the local .gitnexus/ index.
 * Also hosts the MCP server over StreamableHTTP for remote AI tool access.
 *
 * Security: binds to 127.0.0.1 by default (use --host to override).
 * CORS is restricted to localhost, private/LAN networks, and the deployed site.
 */

import express from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'fs/promises';
import { spawn, type ChildProcess } from 'child_process';
import { loadMeta, listRegisteredRepos, loadCLIConfig, saveCLIConfig, getStoragePath } from '../storage/repo-manager.js';
import {
  executeQuery,
  executeWithReusedStatement,
  closeLbug,
  withLbugDb,
} from '../core/lbug/lbug-adapter.js';
import { isWriteQuery } from '../mcp/core/lbug-adapter.js';
import { NODE_TABLES } from '../core/lbug/schema.js';
import { GraphNode, GraphRelationship } from '../core/graph/types.js';
import { searchFTSFromLbug } from '../core/search/bm25-index.js';
import { hybridSearch } from '../core/search/hybrid-search.js';
// Embedding imports are lazy (dynamic import) — only needed when HTTP endpoint is configured
import { LocalBackend } from '../mcp/local/local-backend.js';
import type { Backend } from '../mcp/backend.js';
import { readResource } from '../mcp/resources.js';
import { mountMCPEndpoints } from './mcp-http.js';
import { createRequire } from 'module';

/**
 * Determine whether an HTTP Origin header value is allowed by CORS policy.
 *
 * Permitted origins:
 * - No origin (non-browser requests such as curl or server-to-server calls)
 * - http://localhost:<port> — local development
 * - http://127.0.0.1:<port> — loopback alias
 * - RFC 1918 private/LAN networks (any port):
 *     10.0.0.0/8      → 10.x.x.x
 *     172.16.0.0/12   → 172.16.x.x – 172.31.x.x
 *     192.168.0.0/16  → 192.168.x.x
 * - https://gitnexus.vercel.app — the deployed GitNexus web UI
 *
 * @param origin - The value of the HTTP `Origin` request header, or `undefined`
 *                 when the header is absent (non-browser request).
 * @returns `true` if the origin is allowed, `false` otherwise.
 */
export const isAllowedOrigin = (origin: string | undefined): boolean => {
  if (origin === undefined) {
    // Non-browser requests (curl, server-to-server) have no Origin header
    return true;
  }

  if (
    origin.startsWith('http://localhost:') ||
    origin === 'http://localhost' ||
    origin.startsWith('http://127.0.0.1:') ||
    origin === 'http://127.0.0.1' ||
    origin.startsWith('http://[::1]:') ||
    origin === 'http://[::1]' ||
    origin === 'https://gitnexus.vercel.app'
  ) {
    return true;
  }

  // RFC 1918 private network ranges — allow any port on these hosts.
  // We parse the hostname out of the origin URL and check against each range.
  let hostname: string;
  let protocol: string;
  try {
    const parsed = new URL(origin);
    hostname = parsed.hostname;
    protocol = parsed.protocol;
  } catch {
    // Malformed origin — reject
    return false;
  }

  // Only allow HTTP(S) origins — reject ftp://, file://, etc.
  if (protocol !== 'http:' && protocol !== 'https:') return false;

  const octets = hostname.split('.').map(Number);
  if (octets.length !== 4 || octets.some((o) => !Number.isInteger(o) || o < 0 || o > 255)) {
    return false;
  }

  const [a, b] = octets;

  // 10.0.0.0/8
  if (a === 10) return true;
  // 172.16.0.0/12  →  172.16.x.x – 172.31.x.x
  if (a === 172 && b >= 16 && b <= 31) return true;
  // 192.168.0.0/16
  if (a === 192 && b === 168) return true;

  return false;
};

// ─── Graph Snapshot Cache ──────────────────────────────────────────────
// Pre-serialize graph JSON to disk so repeated web UI loads are instant.
// Snapshots are stored at <storagePath>/graph-snapshot.json alongside the
// LadybugDB files and invalidated when meta.indexedAt changes.

const SNAPSHOT_FILE = 'graph-snapshot.json';

interface GraphSnapshot {
  indexedAt: string;   // tracks freshness — compared against meta.json
  nodes: GraphNode[];
  relationships: GraphRelationship[];
}

/** Read a cached snapshot if it exists and is still fresh. */
const readSnapshot = async (storagePath: string): Promise<GraphSnapshot | null> => {
  try {
    const snapPath = path.join(storagePath, SNAPSHOT_FILE);
    const raw = await fs.readFile(snapPath, 'utf-8');
    const snap: GraphSnapshot = JSON.parse(raw);
    // Validate freshness against meta.json
    const meta = await loadMeta(storagePath);
    if (meta && snap.indexedAt === meta.indexedAt) return snap;
    return null; // stale
  } catch {
    return null;
  }
};

/** Write a graph snapshot to disk. */
const writeSnapshot = async (storagePath: string, snap: GraphSnapshot): Promise<void> => {
  const snapPath = path.join(storagePath, SNAPSHOT_FILE);
  await fs.writeFile(snapPath, JSON.stringify(snap), 'utf-8');
};

/** Delete a snapshot file. */
const deleteSnapshot = async (storagePath: string): Promise<void> => {
  try {
    await fs.unlink(path.join(storagePath, SNAPSHOT_FILE));
  } catch { /* file may not exist */ }
};

/** Build graph and cache it, or return from cache if fresh. */
const getGraphCached = async (storagePath: string): Promise<{ nodes: GraphNode[]; relationships: GraphRelationship[] }> => {
  // Try cache first
  const cached = await readSnapshot(storagePath);
  if (cached) return { nodes: cached.nodes, relationships: cached.relationships };

  // Build from LadybugDB
  const lbugPath = path.join(storagePath, 'lbug');
  const graph = await withLbugDb(lbugPath, async () => buildGraph());

  // Cache to disk asynchronously (don't block the response)
  const meta = await loadMeta(storagePath);
  if (meta) {
    writeSnapshot(storagePath, { indexedAt: meta.indexedAt, ...graph }).catch(() => {});
  }

  return graph;
};

/** Pre-warm snapshot caches for all registered repos on server startup. */
const warmSnapshotCaches = async (): Promise<void> => {
  const repos = await listRegisteredRepos();
  for (const repo of repos) {
    try {
      const cached = await readSnapshot(repo.storagePath);
      if (!cached) {
        console.log(`  Caching graph snapshot for ${repo.name}...`);
        const lbugPath = path.join(repo.storagePath, 'lbug');
        const graph = await withLbugDb(lbugPath, async () => buildGraph());
        const meta = await loadMeta(repo.storagePath);
        if (meta) {
          await writeSnapshot(repo.storagePath, { indexedAt: meta.indexedAt, ...graph });
        }
        console.log(`  Cached ${repo.name}: ${graph.nodes.length} nodes, ${graph.relationships.length} edges`);
      } else {
        console.log(`  Snapshot cache fresh for ${repo.name}`);
      }
    } catch (err: any) {
      console.warn(`  Failed to cache ${repo.name}: ${err.message}`);
    }
  }
};

const buildGraph = async (): Promise<{ nodes: GraphNode[]; relationships: GraphRelationship[] }> => {
  // Load ontology for enrichment
  const { loadOntology, resolveObjectType, getInterfacesForType, resolveLinkType } = await import('../core/ontology/ontology-manager.js');
  const ontology = await loadOntology();

  const nodes: GraphNode[] = [];
  for (const table of NODE_TABLES) {
    try {
      let query = '';
      if (table === 'File') {
        query = includeContent
          ? `MATCH (n:File) RETURN n.id AS id, n.name AS name, n.filePath AS filePath, n.content AS content`
          : `MATCH (n:File) RETURN n.id AS id, n.name AS name, n.filePath AS filePath`;
      } else if (table === 'Folder') {
        query = `MATCH (n:Folder) RETURN n.id AS id, n.name AS name, n.filePath AS filePath`;
      } else if (table === 'Community') {
        query = `MATCH (n:Community) RETURN n.id AS id, n.label AS label, n.heuristicLabel AS heuristicLabel, n.cohesion AS cohesion, n.symbolCount AS symbolCount`;
      } else if (table === 'Process') {
        query = `MATCH (n:Process) RETURN n.id AS id, n.label AS label, n.heuristicLabel AS heuristicLabel, n.processType AS processType, n.stepCount AS stepCount, n.communities AS communities, n.entryPointId AS entryPointId, n.terminalId AS terminalId`;
      } else {
        query = includeContent
          ? `MATCH (n:${table}) RETURN n.id AS id, n.name AS name, n.filePath AS filePath, n.startLine AS startLine, n.endLine AS endLine, n.content AS content`
          : `MATCH (n:${table}) RETURN n.id AS id, n.name AS name, n.filePath AS filePath, n.startLine AS startLine, n.endLine AS endLine`;
      }

      const rows = await executeQuery(query);
      for (const row of rows) {
        // Resolve ontology ObjectType and Interfaces
        const objectType = resolveObjectType(ontology, table) ?? undefined;
        const interfaces = objectType ? getInterfacesForType(ontology, objectType) : [];

        nodes.push({
          id: row.id ?? row[0],
          label: table as GraphNode['label'],
          properties: {
            name: row.name ?? row.label ?? row[1],
            filePath: row.filePath ?? row[2],
            startLine: row.startLine,
            endLine: row.endLine,
            content: includeContent ? row.content : undefined,
            heuristicLabel: row.heuristicLabel,
            cohesion: row.cohesion,
            symbolCount: row.symbolCount,
            processType: row.processType,
            stepCount: row.stepCount,
            communities: row.communities,
            entryPointId: row.entryPointId,
            terminalId: row.terminalId,
          } as GraphNode['properties'],
          // Ontology enrichment
          objectType,
          interfaces,
        });
      }
    } catch {
      // ignore empty tables
    }
  }

  const relationships: GraphRelationship[] = [];
  const relRows = await executeQuery(
    `MATCH (a)-[r:CodeRelation]->(b) RETURN a.id AS sourceId, b.id AS targetId, r.type AS type, r.confidence AS confidence, r.reason AS reason, r.step AS step`,
  );
  for (const row of relRows) {
    const linkType = resolveLinkType(ontology, row.type) ?? undefined;
    const linkDef = linkType ? ontology.linkTypes.find(lt => lt.apiName === linkType) : undefined;

    relationships.push({
      id: `${row.sourceId}_${row.type}_${row.targetId}`,
      type: row.type,
      sourceId: row.sourceId,
      targetId: row.targetId,
      confidence: row.confidence,
      reason: row.reason,
      step: row.step,
      // Ontology enrichment
      linkType,
      cardinality: linkDef?.cardinality,
    });
  }

  return { nodes, relationships };
};

/**
 * Mount an SSE progress endpoint for a JobManager.
 * Handles: initial state, terminal events, heartbeat, event IDs, client disconnect.
 */
const mountSSEProgress = (app: express.Express, routePath: string, jm: JobManager) => {
  app.get(routePath, (req, res) => {
    const job = jm.getJob(req.params.jobId);
    if (!job) {
      res.status(404).json({ error: 'Job not found' });
      return;
    }

    let eventId = 0;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    // Send current state immediately
    eventId++;
    res.write(`id: ${eventId}\ndata: ${JSON.stringify(job.progress)}\n\n`);

    // If already terminal, send event and close
    if (job.status === 'complete' || job.status === 'failed') {
      eventId++;
      res.write(
        `id: ${eventId}\nevent: ${job.status}\ndata: ${JSON.stringify({
          repoName: job.repoName,
          error: job.error,
        })}\n\n`,
      );
      res.end();
      return;
    }

    // Heartbeat to detect zombie connections
    const heartbeat = setInterval(() => {
      try {
        res.write(':heartbeat\n\n');
      } catch {
        clearInterval(heartbeat);
        unsubscribe();
      }
    }, 30_000);

    // Subscribe to progress updates
    const unsubscribe = jm.onProgress(job.id, (progress) => {
      try {
        eventId++;
        if (progress.phase === 'complete' || progress.phase === 'failed') {
          const eventJob = jm.getJob(req.params.jobId);
          res.write(
            `id: ${eventId}\nevent: ${progress.phase}\ndata: ${JSON.stringify({
              repoName: eventJob?.repoName,
              error: eventJob?.error,
            })}\n\n`,
          );
          clearInterval(heartbeat);
          res.end();
          unsubscribe();
        } else {
          res.write(`id: ${eventId}\ndata: ${JSON.stringify(progress)}\n\n`);
        }
      } catch {
        clearInterval(heartbeat);
        unsubscribe();
      }
    });

    req.on('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  });
};

const statusFromError = (err: any): number => {
  const msg = String(err?.message ?? '');
  if (msg.includes('No indexed repositories') || msg.includes('not found')) return 404;
  if (msg.includes('Multiple repositories')) return 400;
  return 500;
};

const requestedRepo = (req: express.Request): string | undefined => {
  const fromQuery = typeof req.query.repo === 'string' ? req.query.repo : undefined;
  if (fromQuery) return fromQuery;

  if (req.body && typeof req.body === 'object' && typeof req.body.repo === 'string') {
    return req.body.repo;
  }

  return undefined;
};

export const createServer = async (port: number, host: string = '127.0.0.1') => {
  const app = express();
  app.disable('x-powered-by');

  // CORS: allow localhost, private/LAN networks, and the deployed site.
  // Non-browser requests (curl, server-to-server) have no origin and are allowed.
  app.use(
    cors({
      origin: (origin, callback) => {
        if (isAllowedOrigin(origin)) {
          callback(null, true);
        } else {
          callback(new Error('Not allowed by CORS'));
        }
      },
    }),
  );
  app.use(express.json({ limit: '10mb' }));

  // ─── Serve Web UI static files ────────────────────────────────────────────
  // When the built web UI exists alongside the server package, serve it here.
  // The web UI needs Cross-Origin Isolation headers for SharedArrayBuffer (WASM).
  const serverDir = path.dirname(new URL(import.meta.url).pathname);
  const webDistDir = process.env.GITNEXUS_WEB_DIR
    ?? path.resolve(serverDir, '../../../gitnexus-web/dist');

  let serveStatic = false;
  try {
    await fs.access(path.join(webDistDir, 'index.html'));
    serveStatic = true;
  } catch { /* web UI not built — skip */ }

  if (serveStatic) {
    // Required headers for SharedArrayBuffer (used by LadybugDB WASM worker)
    app.use((req, res, next) => {
      if (!req.path.startsWith('/api') && !req.path.startsWith('/mcp')) {
        res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
        res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
      }
      next();
    });
    app.use(express.static(webDistDir));
  }

  // Initialize MCP backend (multi-repo, shared across all MCP sessions)
  const backend = new LocalBackend();
  await backend.init();

  // Warm embedding config cache so isHttpMode() works synchronously
  const { warmConfigCache } = await import('../core/embeddings/http-client.js');
  await warmConfigCache();
  const cleanupMcp = mountMCPEndpoints(app, backend);
  const jobManager = new JobManager();

  // Shared repo lock — prevents concurrent analyze + embed on the same repo path,
  // which would corrupt LadybugDB (analyze calls closeLbug + initLbug while embed has queries in flight).
  const activeRepoPaths = new Set<string>();

  const acquireRepoLock = (repoPath: string): string | null => {
    if (activeRepoPaths.has(repoPath)) {
      return `Another job is already active for this repository`;
    }
    activeRepoPaths.add(repoPath);
    return null;
  };

  const releaseRepoLock = (repoPath: string): void => {
    activeRepoPaths.delete(repoPath);
  };

  // Helper: resolve a repo by name from the global registry, or default to first
  const resolveRepo = async (repoName?: string) => {
    const repos = await listRegisteredRepos();
    if (repos.length === 0) return null;
    if (repoName) return repos.find((r) => r.name === repoName) || null;
    return repos[0]; // default to first
  };

  // SSE heartbeat — clients connect to detect server liveness instantly.
  // When the server shuts down, the TCP connection drops and the client's
  // EventSource fires onerror immediately (no polling delay).
  app.get('/api/heartbeat', (_req, res) => {
    // Use res.set() instead of res.writeHead() to preserve CORS headers from middleware
    res.set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.flushHeaders();
    // Send initial ping so the client knows it connected
    res.write(':ok\n\n');

    // Keep-alive ping every 15s to prevent proxy/firewall timeout
    const interval = setInterval(() => res.write(':ping\n\n'), 15_000);

    _req.on('close', () => clearInterval(interval));
  });

  // Server info: version and launch context (npx / global / local dev)
  app.get('/api/info', (_req, res) => {
    const execPath = process.env.npm_execpath ?? '';
    const argv0 = process.argv[1] ?? '';
    let launchContext: 'npx' | 'global' | 'local';
    if (
      execPath.includes('npx') ||
      argv0.includes('_npx') ||
      process.env.npm_config_prefix?.includes('_npx')
    ) {
      launchContext = 'npx';
    } else if (argv0.includes('node_modules')) {
      launchContext = 'local';
    } else {
      launchContext = 'global';
    }
    res.json({ version: pkg.version, launchContext, nodeVersion: process.version });
  });

  // List all registered repos
  app.get('/api/repos', async (_req, res) => {
    try {
      const repos = await listRegisteredRepos();
      res.json(
        repos.map((r) => ({
          name: r.name,
          path: r.path,
          indexedAt: r.indexedAt,
          lastCommit: r.lastCommit,
          stats: r.stats,
        })),
      );
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Failed to list repos' });
    }
  });

  // Get repo info
  app.get('/api/repo', async (req, res) => {
    try {
      const entry = await resolveRepo(requestedRepo(req));
      if (!entry) {
        res.status(404).json({ error: 'Repository not found. Run: gitnexus analyze' });
        return;
      }
      const meta = await loadMeta(entry.storagePath);
      res.json({
        name: entry.name,
        repoPath: entry.path,
        indexedAt: meta?.indexedAt ?? entry.indexedAt,
        stats: meta?.stats ?? entry.stats ?? {},
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Failed to get repo info' });
    }
  });

  // Delete a repo — removes index and unregisters it
  app.delete('/api/repo', async (req, res) => {
    try {
      const repoName = requestedRepo(req);
      if (!repoName) {
        res.status(400).json({ error: 'Missing repo name' });
        return;
      }
      const entry = await resolveRepo(repoName);
      if (!entry) {
        res.status(404).json({ error: 'Repository not found' });
        return;
      }

      // Acquire repo lock — prevents deleting while analyze/embed is in flight
      const lockKey = getStoragePath(entry.path);
      const lockErr = acquireRepoLock(lockKey);
      if (lockErr) {
        res.status(409).json({ error: lockErr });
        return;
      }

      try {
        // Close any open LadybugDB handle before deleting files
        try {
          await closeLbug();
        } catch {}

        // 1. Delete the .gitnexus index/storage directory
        const storagePath = getStoragePath(entry.path);
        await fs.rm(storagePath, { recursive: true, force: true }).catch(() => {});

        // 2. Unregister from the global registry
        const { unregisterRepo } = await import('../storage/repo-manager.js');
        await unregisterRepo(entry.path);

        // 3. Reinitialize backend to reflect the removal
        await backend.init().catch(() => {});

        res.json({ deleted: entry.name });
      } finally {
        releaseRepoLock(lockKey);
      }
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Failed to delete repo' });
    }
  });

  // Get full graph (served from disk cache when available)
  app.get('/api/graph', async (req, res) => {
    try {
      const entry = await resolveRepo(requestedRepo(req));
      if (!entry) {
        res.status(404).json({ error: 'Repository not found' });
        return;
      }
      const graph = await getGraphCached(entry.storagePath);
      res.json(graph);
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Failed to build graph' });
    }
  });

  // Execute Cypher query
  app.post('/api/query', async (req, res) => {
    try {
      const cypher = req.body.cypher as string;
      if (!cypher) {
        res.status(400).json({ error: 'Missing "cypher" in request body' });
        return;
      }

      if (isWriteQuery(cypher)) {
        res.status(403).json({ error: 'Write queries are not allowed via the HTTP API' });
        return;
      }

      const entry = await resolveRepo(requestedRepo(req));
      if (!entry) {
        res.status(404).json({ error: 'Repository not found' });
        return;
      }
      const lbugPath = path.join(entry.storagePath, 'lbug');
      const result = await withLbugDb(lbugPath, () => executeQuery(cypher));
      res.json({ result });
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Query failed' });
    }
  });

  // Search (supports mode: 'hybrid' | 'semantic' | 'bm25', and optional enrichment)
  app.post('/api/search', async (req, res) => {
    try {
      const query = (req.body.query ?? '').trim();
      if (!query) {
        res.status(400).json({ error: 'Missing "query" in request body' });
        return;
      }

      const entry = await resolveRepo(requestedRepo(req));
      if (!entry) {
        res.status(404).json({ error: 'Repository not found' });
        return;
      }
      const lbugPath = path.join(entry.storagePath, 'lbug');
      const parsedLimit = Number(req.body.limit ?? 10);
      const limit = Number.isFinite(parsedLimit)
        ? Math.max(1, Math.min(100, Math.trunc(parsedLimit)))
        : 10;
      const mode: string = req.body.mode ?? 'hybrid';
      const enrich: boolean = req.body.enrich !== false; // default true

      const results = await withLbugDb(lbugPath, async () => {
        let searchResults: any[];

        if (mode === 'semantic') {
          const { isEmbedderReady } = await import('../core/embeddings/embedder.js');
          if (!isEmbedderReady()) {
            return [] as any[];
          }
          const { semanticSearch: semSearch } =
            await import('../core/embeddings/embedding-pipeline.js');
          searchResults = await semSearch(executeQuery, query, limit);
          // Normalize semantic results to HybridSearchResult shape
          searchResults = searchResults.map((r: any, i: number) => ({
            ...r,
            score: r.score ?? 1 - (r.distance ?? 0),
            rank: i + 1,
            sources: ['semantic'],
          }));
        } else if (mode === 'bm25') {
          searchResults = await searchFTSFromLbug(query, limit);
          searchResults = searchResults.map((r: any, i: number) => ({
            ...r,
            rank: i + 1,
            sources: ['bm25'],
          }));
        } else {
          // hybrid (default)
          const { isEmbedderReady } = await import('../core/embeddings/embedder.js');
          if (isEmbedderReady()) {
            const { semanticSearch: semSearch } =
              await import('../core/embeddings/embedding-pipeline.js');
            searchResults = await hybridSearch(query, limit, executeQuery, semSearch);
          } else {
            searchResults = await searchFTSFromLbug(query, limit);
          }
        }

        if (!enrich) return searchResults;

        // Server-side enrichment: add connections, cluster, processes per result
        // Uses parameterized queries to prevent Cypher injection via nodeId
        const validLabel = (label: string): boolean =>
          (NODE_TABLES as readonly string[]).includes(label);

        const enriched = await Promise.all(
          searchResults.slice(0, limit).map(async (r: any) => {
            const nodeId: string = r.nodeId || r.id || '';
            const nodeLabel = nodeId.split(':')[0];
            const enrichment: { connections?: any; cluster?: string; processes?: any[] } = {};

            if (!nodeId || !validLabel(nodeLabel)) return { ...r, ...enrichment };

            // Run connections, cluster, and process queries in parallel
            // Label is validated against NODE_TABLES (compile-time safe identifiers);
            // nodeId uses $nid parameter binding to prevent injection
            const [connRes, clusterRes, procRes] = await Promise.all([
              executePrepared(
                `
              MATCH (n:${nodeLabel} {id: $nid})
              OPTIONAL MATCH (n)-[r1:CodeRelation]->(dst)
              OPTIONAL MATCH (src)-[r2:CodeRelation]->(n)
              RETURN
                collect(DISTINCT {name: dst.name, type: r1.type, confidence: r1.confidence}) AS outgoing,
                collect(DISTINCT {name: src.name, type: r2.type, confidence: r2.confidence}) AS incoming
              LIMIT 1
            `,
                { nid: nodeId },
              ).catch(() => []),
              executePrepared(
                `
              MATCH (n:${nodeLabel} {id: $nid})
              MATCH (n)-[:CodeRelation {type: 'MEMBER_OF'}]->(c:Community)
              RETURN c.label AS label, c.description AS description
              LIMIT 1
            `,
                { nid: nodeId },
              ).catch(() => []),
              executePrepared(
                `
              MATCH (n:${nodeLabel} {id: $nid})
              MATCH (n)-[rel:CodeRelation {type: 'STEP_IN_PROCESS'}]->(p:Process)
              RETURN p.id AS id, p.label AS label, rel.step AS step, p.stepCount AS stepCount
              ORDER BY rel.step
            `,
                { nid: nodeId },
              ).catch(() => []),
            ]);

            if (connRes.length > 0) {
              const row = connRes[0];
              const outgoing = (Array.isArray(row) ? row[0] : row.outgoing || [])
                .filter((c: any) => c?.name)
                .slice(0, 5);
              const incoming = (Array.isArray(row) ? row[1] : row.incoming || [])
                .filter((c: any) => c?.name)
                .slice(0, 5);
              enrichment.connections = { outgoing, incoming };
            }

            if (clusterRes.length > 0) {
              const row = clusterRes[0];
              enrichment.cluster = Array.isArray(row) ? row[0] : row.label;
            }

            if (procRes.length > 0) {
              enrichment.processes = procRes
                .map((row: any) => ({
                  id: Array.isArray(row) ? row[0] : row.id,
                  label: Array.isArray(row) ? row[1] : row.label,
                  step: Array.isArray(row) ? row[2] : row.step,
                  stepCount: Array.isArray(row) ? row[3] : row.stepCount,
                }))
                .filter((p: any) => p.id && p.label);
            }

            return { ...r, ...enrichment };
          }),
        );

        return enriched;
      });
      res.json({ results });
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Search failed' });
    }
  });

  // Read file — with path traversal guard
  app.get('/api/file', async (req, res) => {
    try {
      const entry = await resolveRepo(requestedRepo(req));
      if (!entry) {
        res.status(404).json({ error: 'Repository not found' });
        return;
      }
      const filePath = req.query.path as string;
      if (!filePath) {
        res.status(400).json({ error: 'Missing path' });
        return;
      }

      // Prevent path traversal — resolve and verify the path stays within the repo root
      const repoRoot = path.resolve(entry.path);
      const fullPath = path.resolve(repoRoot, filePath);
      if (!fullPath.startsWith(repoRoot + path.sep) && fullPath !== repoRoot) {
        res.status(403).json({ error: 'Path traversal denied' });
        return;
      }

      const raw = await fs.readFile(fullPath, 'utf-8');

      // Optional line-range support: ?startLine=10&endLine=50
      // Returns only the requested slice (0-indexed), plus metadata.
      const startLine = req.query.startLine !== undefined ? Number(req.query.startLine) : undefined;
      const endLine = req.query.endLine !== undefined ? Number(req.query.endLine) : undefined;

      if (startLine !== undefined && Number.isFinite(startLine)) {
        const lines = raw.split('\n');
        const start = Math.max(0, startLine);
        const end =
          endLine !== undefined && Number.isFinite(endLine)
            ? Math.min(lines.length, endLine + 1)
            : lines.length;
        res.json({
          content: lines.slice(start, end).join('\n'),
          startLine: start,
          endLine: end - 1,
          totalLines: lines.length,
        });
      } else {
        res.json({ content: raw, totalLines: raw.split('\n').length });
      }
    } catch (err: any) {
      if (err.code === 'ENOENT') {
        res.status(404).json({ error: 'File not found' });
      } else {
        res.status(500).json({ error: err.message || 'Failed to read file' });
      }
    }
  });

  // Grep — regex search across file contents in the indexed repo
  // Uses filesystem-based search for memory efficiency (never loads all files into memory)
  app.get('/api/grep', async (req, res) => {
    try {
      const entry = await resolveRepo(requestedRepo(req));
      if (!entry) {
        res.status(404).json({ error: 'Repository not found' });
        return;
      }
      const pattern = req.query.pattern as string;
      if (!pattern) {
        res.status(400).json({ error: 'Missing "pattern" query parameter' });
        return;
      }

      // ReDoS protection: reject overly long or dangerous patterns
      if (pattern.length > 200) {
        res.status(400).json({ error: 'Pattern too long (max 200 characters)' });
        return;
      }

      // Validate regex syntax
      let regex: RegExp;
      try {
        regex = new RegExp(pattern, 'gim');
      } catch {
        res.status(400).json({ error: 'Invalid regex pattern' });
        return;
      }

      const parsedLimit = Number(req.query.limit ?? 50);
      const limit = Number.isFinite(parsedLimit)
        ? Math.max(1, Math.min(200, Math.trunc(parsedLimit)))
        : 50;

      const results: { filePath: string; line: number; text: string }[] = [];
      const repoRoot = path.resolve(entry.path);

      // Get file paths from the graph (lightweight — no content loaded)
      const lbugPath = path.join(entry.storagePath, 'lbug');
      const fileRows = await withLbugDb(lbugPath, () =>
        executeQuery(`MATCH (n:File) WHERE n.content IS NOT NULL RETURN n.filePath AS filePath`),
      );

      // Search files on disk one at a time (constant memory)
      for (const row of fileRows) {
        if (results.length >= limit) break;
        const filePath: string = row.filePath || '';
        const fullPath = path.resolve(repoRoot, filePath);

        // Path traversal guard
        if (!fullPath.startsWith(repoRoot + path.sep) && fullPath !== repoRoot) continue;

        let content: string;
        try {
          content = await fs.readFile(fullPath, 'utf-8');
        } catch {
          continue; // File may have been deleted since indexing
        }

        const lines = content.split('\n');
        for (let i = 0; i < lines.length; i++) {
          if (results.length >= limit) break;
          if (regex.test(lines[i])) {
            results.push({ filePath, line: i + 1, text: lines[i].trim().slice(0, 200) });
          }
          regex.lastIndex = 0;
        }
      }

      res.json({ results });
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Grep failed' });
    }
  });

  // List all processes
  app.get('/api/processes', async (req, res) => {
    try {
      const result = await backend.queryProcesses(requestedRepo(req));
      res.json(result);
    } catch (err: any) {
      res.status(statusFromError(err)).json({ error: err.message || 'Failed to query processes' });
    }
  });

  // Process detail
  app.get('/api/process', async (req, res) => {
    try {
      const name = String(req.query.name ?? '').trim();
      if (!name) {
        res.status(400).json({ error: 'Missing "name" query parameter' });
        return;
      }

      const result = await backend.queryProcessDetail(name, requestedRepo(req));
      if (result?.error) {
        res.status(404).json({ error: result.error });
        return;
      }
      res.json(result);
    } catch (err: any) {
      res
        .status(statusFromError(err))
        .json({ error: err.message || 'Failed to query process detail' });
    }
  });

  // List all clusters
  app.get('/api/clusters', async (req, res) => {
    try {
      const result = await backend.queryClusters(requestedRepo(req));
      res.json(result);
    } catch (err: any) {
      res.status(statusFromError(err)).json({ error: err.message || 'Failed to query clusters' });
    }
  });

  // Cluster detail
  app.get('/api/cluster', async (req, res) => {
    try {
      const name = String(req.query.name ?? '').trim();
      if (!name) {
        res.status(400).json({ error: 'Missing "name" query parameter' });
        return;
      }

      const result = await backend.queryClusterDetail(name, requestedRepo(req));
      if (result?.error) {
        res.status(404).json({ error: result.error });
        return;
      }
      res.json(result);
    } catch (err: any) {
      res
        .status(statusFromError(err))
        .json({ error: err.message || 'Failed to query cluster detail' });
    }
  });

  // ─── Ontology Schema API ────────────────────────────────────────────

  // GET ontology schema (full)
  app.get('/api/ontology/schema', async (_req, res) => {
    try {
      const { loadOntology } = await import('../core/ontology/ontology-manager.js');
      const schema = await loadOntology();
      res.json(schema);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET ontology summary (compact — for AI agents)
  app.get('/api/ontology/summary', async (_req, res) => {
    try {
      const { loadOntology } = await import('../core/ontology/ontology-manager.js');
      const schema = await loadOntology();
      res.json({
        version: schema.version,
        name: schema.name,
        interfaces: schema.interfaces.map(i => ({
          apiName: i.apiName, displayName: i.displayName, extends: i.extends,
          properties: i.properties.map(p => p.apiName),
        })),
        objectTypes: schema.objectTypes.map(ot => ({
          apiName: ot.apiName, displayName: ot.displayName,
          interfaces: ot.interfaces, status: ot.status,
          sourceLabels: ot.sourceLabels,
        })),
        linkTypes: schema.linkTypes.map(lt => ({
          apiName: lt.apiName, displayName: lt.displayName,
          sourceType: lt.sourceType, targetType: lt.targetType,
          cardinality: lt.cardinality, status: lt.status,
        })),
        sharedProperties: schema.sharedProperties.map(sp => ({
          apiName: sp.apiName, baseType: sp.baseType,
        })),
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // PUT save custom ontology schema
  app.put('/api/ontology/schema', async (req, res) => {
    try {
      const schema = req.body;
      if (!schema?.version || !schema?.objectTypes || !schema?.linkTypes) {
        res.status(400).json({ error: 'Invalid schema: must have version, objectTypes, linkTypes' });
        return;
      }
      const { saveOntology } = await import('../core/ontology/ontology-manager.js');
      await saveOntology(schema);
      res.json({ status: 'ok', version: schema.version, objectTypes: schema.objectTypes.length, linkTypes: schema.linkTypes.length });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // DELETE reset to default ontology
  app.delete('/api/ontology/schema', async (_req, res) => {
    try {
      const { resetOntology } = await import('../core/ontology/ontology-manager.js');
      const defaultSchema = await resetOntology();
      res.json({ status: 'ok', version: defaultSchema.version });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET resolve a NodeLabel to its Object Type
  app.get('/api/ontology/resolve', async (req, res) => {
    try {
      const { loadOntology, resolveObjectType, resolveLinkType, getInterfacesForType } = await import('../core/ontology/ontology-manager.js');
      const schema = await loadOntology();
      const nodeLabel = req.query.nodeLabel as string | undefined;
      const relType = req.query.relType as string | undefined;

      const result: any = {};
      if (nodeLabel) {
        const objectType = resolveObjectType(schema, nodeLabel);
        result.objectType = objectType;
        if (objectType) {
          result.interfaces = getInterfacesForType(schema, objectType);
        }
      }
      if (relType) {
        result.linkType = resolveLinkType(schema, relType);
      }
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ─── Embedding Config API ───────────────────────────────────────────

  // GET current embedding configuration (API key masked)
  app.get('/api/config/embedding', async (_req, res) => {
    try {
      const config = await loadCLIConfig();
      const emb = config.embedding;
      if (!emb?.url) {
        res.json({ configured: false });
        return;
      }
      res.json({
        configured: true,
        url: emb.url,
        model: emb.model,
        dimensions: emb.dimensions,
        apiKey: emb.apiKey ? `${emb.apiKey.slice(0, 8)}...` : undefined,
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // PUT update embedding configuration
  app.put('/api/config/embedding', async (req, res) => {
    try {
      const { url, model, apiKey, dimensions } = req.body;
      if (!url || !model) {
        res.status(400).json({ error: 'Missing required fields: url, model' });
        return;
      }
      if (dimensions !== undefined && (!Number.isInteger(dimensions) || dimensions <= 0)) {
        res.status(400).json({ error: 'dimensions must be a positive integer' });
        return;
      }

      const config = await loadCLIConfig();
      config.embedding = {
        url: String(url).replace(/\/+$/, ''),
        model: String(model),
        apiKey: apiKey ? String(apiKey) : undefined,
        dimensions: dimensions ? Number(dimensions) : undefined,
      };
      await saveCLIConfig(config);

      // Apply in-memory so subsequent embed calls use the new config immediately
      const { setEmbeddingConfig, warmConfigCache } = await import('../core/embeddings/http-client.js');
      setEmbeddingConfig(config.embedding);
      await warmConfigCache();

      res.json({ status: 'ok', embedding: { url: config.embedding.url, model: config.embedding.model, dimensions: config.embedding.dimensions } });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // DELETE remove embedding configuration
  app.delete('/api/config/embedding', async (_req, res) => {
    try {
      const config = await loadCLIConfig();
      delete config.embedding;
      await saveCLIConfig(config);

      const { setEmbeddingConfig } = await import('../core/embeddings/http-client.js');
      setEmbeddingConfig(null);

      res.json({ status: 'ok' });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST test embedding configuration (sends a test query to the endpoint)
  app.post('/api/config/embedding/test', async (req, res) => {
    try {
      const { url, model, apiKey, dimensions } = req.body;
      if (!url || !model) {
        res.status(400).json({ error: 'Missing required fields: url, model' });
        return;
      }

      // Temporarily apply config for the test
      const { setEmbeddingConfig } = await import('../core/embeddings/http-client.js');
      const prevOverride = await import('../core/embeddings/http-client.js').then(m => m.getActiveEmbeddingConfig());
      setEmbeddingConfig({ url, model, apiKey, dimensions });

      try {
        const { httpEmbedQuery } = await import('../core/embeddings/http-client.js');
        const vec = await httpEmbedQuery('test connection');
        res.json({ status: 'ok', dimensions: vec.length, message: `Embedding endpoint returned ${vec.length}-dimensional vector` });
      } catch (testErr: any) {
        res.status(400).json({ status: 'error', error: testErr.message });
      } finally {
        // Restore previous config
        const prev = await prevOverride;
        setEmbeddingConfig(prev);
      }
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ─── Service API (for RemoteBackend clients) ────────────────────────

  // Health check
  const _require = createRequire(import.meta.url);
  const pkgVersion: string = _require('../../package.json').version;

  app.get('/api/health', async (_req, res) => {
    try {
      const repos = await backend.listRepos();
      res.json({ status: 'ok', version: pkgVersion, repos: repos.length });
    } catch (err: any) {
      res.status(500).json({ status: 'error', error: err.message });
    }
  });

  // Generic tool dispatch — mirrors backend.callTool(method, params)
  app.post('/api/tools/:method', async (req, res) => {
    const method = req.params.method;
    try {
      const result = await backend.callTool(method, req.body || {});
      res.json({ result });
    } catch (err: any) {
      res.status(statusFromError(err)).json({ error: err.message || 'Tool call failed' });
    }
  });

  // Resource read — mirrors readResource(uri, backend)
  app.get('/api/resources', async (req, res) => {
    const uri = req.query.uri as string;
    if (!uri) {
      res.status(400).json({ error: 'Missing "uri" query parameter' });
      return;
    }
    try {
      const content = await readResource(uri, backend);
      res.json({ content, mimeType: 'text/yaml' });
    } catch (err: any) {
      res.status(statusFromError(err)).json({ error: err.message || 'Resource read failed' });
    }
  });

  // Internal endpoints for RemoteBackend resource backing
  app.post('/api/internal/context-info', async (req, res) => {
    try {
      const repo = await backend.resolveRepo(req.body?.repoName);
      const repoId = repo.name.toLowerCase();
      const context = backend.getContext(repoId) || backend.getContext();
      res.json({ context, repo: { name: repo.name, repoPath: repo.repoPath, lastCommit: repo.lastCommit } });
    } catch (err: any) {
      res.status(statusFromError(err)).json({ error: err.message });
    }
  });

  app.post('/api/internal/clusters', async (req, res) => {
    try {
      const result = await backend.queryClusters(req.body?.repoName, req.body?.limit);
      res.json(result);
    } catch (err: any) {
      res.status(statusFromError(err)).json({ error: err.message });
    }
  });

  app.post('/api/internal/processes', async (req, res) => {
    try {
      const result = await backend.queryProcesses(req.body?.repoName, req.body?.limit);
      res.json(result);
    } catch (err: any) {
      res.status(statusFromError(err)).json({ error: err.message });
    }
  });

  app.post('/api/internal/cluster-detail', async (req, res) => {
    try {
      const result = await backend.queryClusterDetail(req.body?.name, req.body?.repoName);
      res.json(result);
    } catch (err: any) {
      res.status(statusFromError(err)).json({ error: err.message });
    }
  });

  app.post('/api/internal/process-detail', async (req, res) => {
    try {
      const result = await backend.queryProcessDetail(req.body?.name, req.body?.repoName);
      res.json(result);
    } catch (err: any) {
      res.status(statusFromError(err)).json({ error: err.message });
    }
  });

  // ─── Graph Management API ───────────────────────────────────────────────

  // List all graph snapshots with their status
  app.get('/api/graphs', async (_req, res) => {
    try {
      const repos = await listRegisteredRepos();
      const graphs = await Promise.all(repos.map(async (repo) => {
        const snap = await readSnapshot(repo.storagePath);
        const meta = await loadMeta(repo.storagePath);
        return {
          name: repo.name,
          path: repo.path,
          indexedAt: meta?.indexedAt ?? repo.indexedAt,
          stats: meta?.stats ?? repo.stats ?? {},
          cached: !!snap,
          cacheStale: snap ? snap.indexedAt !== meta?.indexedAt : false,
        };
      }));
      res.json({ graphs });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Force rebuild snapshot cache for a specific repo
  app.post('/api/graphs/:name/cache', async (req, res) => {
    try {
      const repos = await listRegisteredRepos();
      const repo = repos.find(r => r.name === req.params.name);
      if (!repo) { res.status(404).json({ error: 'Repository not found' }); return; }

      const lbugPath = path.join(repo.storagePath, 'lbug');
      const graph = await withLbugDb(lbugPath, async () => buildGraph());
      const meta = await loadMeta(repo.storagePath);
      if (meta) {
        await writeSnapshot(repo.storagePath, { indexedAt: meta.indexedAt, ...graph });
      }
      res.json({ status: 'ok', nodes: graph.nodes.length, relationships: graph.relationships.length });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Delete snapshot cache for a specific repo
  app.delete('/api/graphs/:name/cache', async (req, res) => {
    try {
      const repos = await listRegisteredRepos();
      const repo = repos.find(r => r.name === req.params.name);
      if (!repo) { res.status(404).json({ error: 'Repository not found' }); return; }

      await deleteSnapshot(repo.storagePath);
      res.json({ status: 'ok' });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Rebuild all snapshot caches
  app.post('/api/graphs/cache-all', async (_req, res) => {
    try {
      await warmSnapshotCaches();
      res.json({ status: 'ok' });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ─── Analyze (Index) API ───────────────────────────────────────────────
  // Spawn `gitnexus analyze` as a child process and stream progress via SSE.

  // Track active analyze jobs so only one runs at a time
  let activeAnalyzeJob: { proc: ChildProcess; repoPath: string } | null = null;

  /**
   * POST /api/analyze
   * Body: { path: string, embeddings?: boolean, force?: boolean }
   * Response: SSE stream with progress events
   *
   * Events:
   *   data: {"phase":"scanning","percent":30,"message":"Scanning files"}
   *   data: {"phase":"done","percent":100,"message":"Analysis complete"}
   *   data: {"phase":"error","message":"..."}
   */
  app.post('/api/analyze', async (req, res) => {
    const { path: repoPath, embeddings, force } = req.body ?? {};

    if (!repoPath || typeof repoPath !== 'string') {
      res.status(400).json({ error: 'Missing required field: path' });
      return;
    }

    // Validate path exists and is a directory
    try {
      const stat = await fs.stat(repoPath);
      if (!stat.isDirectory()) {
        res.status(400).json({ error: 'Path is not a directory' });
        return;
      }
    } catch {
      res.status(400).json({ error: 'Path does not exist or is not accessible' });
      return;
    }

    if (activeAnalyzeJob) {
      res.status(409).json({
        error: 'Analysis already in progress',
        currentRepo: activeAnalyzeJob.repoPath,
      });
      return;
    }

    // Set up SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    const sendEvent = (data: Record<string, unknown>) => {
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    // Build args for gitnexus analyze
    const args = ['analyze', repoPath];
    if (embeddings) args.push('--embeddings');
    if (force) args.push('--force');
    args.push('--skip-git'); // Allow non-git dirs from web UI

    // Find the gitnexus CLI entry point (dist/cli/index.js relative to package root)
    const serverDir = import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname);
    const cliPath = path.resolve(serverDir, '../cli/index.js');

    const proc = spawn(process.execPath, [cliPath, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, FORCE_COLOR: '0' },
    });

    activeAnalyzeJob = { proc, repoPath };

    sendEvent({ phase: 'started', percent: 0, message: `Analyzing ${path.basename(repoPath)}...` });

    // Parse progress from CLI output (progress bar format: "  ███░░░░ 45% | Scanning files")
    const parseProgress = (line: string) => {
      // Match: "  ██████░░ 60% | Phase label (5s)"
      const barMatch = line.match(/(\d+)%\s*\|\s*(.+)/);
      if (barMatch) {
        const percent = parseInt(barMatch[1], 10);
        const message = barMatch[2].replace(/\s*\(\d+s\)\s*$/, '').trim();
        sendEvent({ phase: 'progress', percent, message });
        return;
      }
      // Pass through informational messages (non-empty, non-bar lines)
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith('█') && !trimmed.startsWith('░')) {
        sendEvent({ phase: 'info', message: trimmed });
      }
    };

    let stdoutBuf = '';
    proc.stdout?.on('data', (chunk: Buffer) => {
      stdoutBuf += chunk.toString();
      // Progress bar uses \r to overwrite — split on both \n and \r
      const lines = stdoutBuf.split(/[\r\n]+/);
      stdoutBuf = lines.pop() || '';
      for (const line of lines) {
        parseProgress(line);
      }
    });

    let stderrBuf = '';
    proc.stderr?.on('data', (chunk: Buffer) => {
      stderrBuf += chunk.toString();
    });

    proc.on('close', async (code) => {
      activeAnalyzeJob = null;
      // Flush remaining buffer
      if (stdoutBuf.trim()) parseProgress(stdoutBuf);

      if (code === 0) {
        // Rebuild snapshot cache for the new repo so it's ready for the UI
        try {
          const repos = await listRegisteredRepos();
          const repoName = path.basename(repoPath);
          const repo = repos.find(r => r.name === repoName || r.path === repoPath);
          if (repo) {
            const lbugPath = path.join(repo.storagePath, 'lbug');
            const graph = await withLbugDb(lbugPath, async () => buildGraph());
            const meta = await loadMeta(repo.storagePath);
            if (meta) {
              await writeSnapshot(repo.storagePath, { indexedAt: meta.indexedAt, ...graph });
            }
          }
        } catch (err: any) {
          console.warn('Failed to build snapshot for new repo:', err.message);
        }

        sendEvent({ phase: 'done', percent: 100, message: 'Analysis complete' });
      } else {
        sendEvent({
          phase: 'error',
          message: stderrBuf.trim() || `Analysis failed with exit code ${code}`,
        });
      }
      res.end();
    });

    proc.on('error', (err) => {
      activeAnalyzeJob = null;
      sendEvent({ phase: 'error', message: `Failed to start analysis: ${err.message}` });
      res.end();
    });

    // Handle client disconnect
    req.on('close', () => {
      if (activeAnalyzeJob?.proc === proc) {
        proc.kill('SIGTERM');
        activeAnalyzeJob = null;
      }
    });
  });

  // Check active analysis status
  app.get('/api/analyze/status', (_req, res) => {
    if (activeAnalyzeJob) {
      res.json({ active: true, repoPath: activeAnalyzeJob.repoPath });
    } else {
      res.json({ active: false });
    }
  });

  // SPA fallback — serve index.html for all non-API routes so client-side
  // routing works (e.g. refreshing on /#repo=GitNexus still loads the app).
  if (serveStatic) {
    app.get('*', (req, res, next) => {
      if (req.path.startsWith('/api') || req.path.startsWith('/mcp')) return next();
      res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
      res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
      res.sendFile(path.join(webDistDir, 'index.html'));
    });
  }

  // Global error handler — catch anything the route handlers miss
  app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error('Unhandled error:', err);
    res.status(500).json({ error: 'Internal server error' });
  });

  // Pre-warm graph snapshot caches on startup (don't block the listener)
  console.log('Warming graph snapshot caches...');
  warmSnapshotCaches()
    .then(() => console.log('Snapshot caches ready.'))
    .catch((err) => console.warn('Snapshot cache warming failed:', err.message));

  // Wrap listen in a promise so errors (EADDRINUSE, EACCES, etc.) propagate
  // to the caller instead of crashing with an unhandled 'error' event.
  await new Promise<void>((resolve, reject) => {
    const server = app.listen(port, host, () => {
      console.log(`GitNexus server running on http://${host}:${port}`);
      resolve();
    });
    server.on('error', (err) => reject(err));

    // Graceful shutdown — close Express + LadybugDB cleanly
    const shutdown = async () => {
      console.log('\nShutting down...');
      server.close();
      jobManager.dispose();
      await cleanupMcp();
      await closeLbug();
      await backend.disconnect();
      process.exit(0);
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  });
};
