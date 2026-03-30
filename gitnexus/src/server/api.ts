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
import { loadMeta, listRegisteredRepos, loadCLIConfig, saveCLIConfig } from '../storage/repo-manager.js';
import { executeQuery, closeLbug, withLbugDb } from '../core/lbug/lbug-adapter.js';
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
    origin.startsWith('http://localhost:')
    || origin === 'http://localhost'
    || origin.startsWith('http://127.0.0.1:')
    || origin === 'http://127.0.0.1'
    || origin.startsWith('http://[::1]:')
    || origin === 'http://[::1]'
    || origin === 'https://gitnexus.vercel.app'
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
  if (octets.length !== 4 || octets.some(o => !Number.isInteger(o) || o < 0 || o > 255)) {
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

const buildGraph = async (): Promise<{ nodes: GraphNode[]; relationships: GraphRelationship[] }> => {
  const nodes: GraphNode[] = [];
  for (const table of NODE_TABLES) {
    try {
      let query = '';
      if (table === 'File') {
        query = `MATCH (n:File) RETURN n.id AS id, n.name AS name, n.filePath AS filePath, n.content AS content`;
      } else if (table === 'Folder') {
        query = `MATCH (n:Folder) RETURN n.id AS id, n.name AS name, n.filePath AS filePath`;
      } else if (table === 'Community') {
        query = `MATCH (n:Community) RETURN n.id AS id, n.label AS label, n.heuristicLabel AS heuristicLabel, n.cohesion AS cohesion, n.symbolCount AS symbolCount`;
      } else if (table === 'Process') {
        query = `MATCH (n:Process) RETURN n.id AS id, n.label AS label, n.heuristicLabel AS heuristicLabel, n.processType AS processType, n.stepCount AS stepCount, n.communities AS communities, n.entryPointId AS entryPointId, n.terminalId AS terminalId`;
      } else {
        query = `MATCH (n:${table}) RETURN n.id AS id, n.name AS name, n.filePath AS filePath, n.startLine AS startLine, n.endLine AS endLine, n.content AS content`;
      }

      const rows = await executeQuery(query);
      for (const row of rows) {
        nodes.push({
          id: row.id ?? row[0],
          label: table as GraphNode['label'],
          properties: {
            name: row.name ?? row.label ?? row[1],
            filePath: row.filePath ?? row[2],
            startLine: row.startLine,
            endLine: row.endLine,
            content: row.content,
            heuristicLabel: row.heuristicLabel,
            cohesion: row.cohesion,
            symbolCount: row.symbolCount,
            processType: row.processType,
            stepCount: row.stepCount,
            communities: row.communities,
            entryPointId: row.entryPointId,
            terminalId: row.terminalId,
          } as GraphNode['properties'],
        });
      }
    } catch {
      // ignore empty tables
    }
  }

  const relationships: GraphRelationship[] = [];
  const relRows = await executeQuery(
    `MATCH (a)-[r:CodeRelation]->(b) RETURN a.id AS sourceId, b.id AS targetId, r.type AS type, r.confidence AS confidence, r.reason AS reason, r.step AS step`
  );
  for (const row of relRows) {
    relationships.push({
      id: `${row.sourceId}_${row.type}_${row.targetId}`,
      type: row.type,
      sourceId: row.sourceId,
      targetId: row.targetId,
      confidence: row.confidence,
      reason: row.reason,
      step: row.step,
    });
  }

  return { nodes, relationships };
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

  // CORS: allow localhost, private/LAN networks, and the deployed site.
  // Non-browser requests (curl, server-to-server) have no origin and are allowed.
  app.use(cors({
    origin: (origin, callback) => {
      if (isAllowedOrigin(origin)) {
        callback(null, true);
      } else {
        callback(new Error('Not allowed by CORS'));
      }
    }
  }));
  app.use(express.json({ limit: '10mb' }));

  // Initialize MCP backend (multi-repo, shared across all MCP sessions)
  const backend = new LocalBackend();
  await backend.init();

  // Warm embedding config cache so isHttpMode() works synchronously
  const { warmConfigCache } = await import('../core/embeddings/http-client.js');
  await warmConfigCache();
  const cleanupMcp = mountMCPEndpoints(app, backend);

  // Helper: resolve a repo by name from the global registry, or default to first
  const resolveRepo = async (repoName?: string) => {
    const repos = await listRegisteredRepos();
    if (repos.length === 0) return null;
    if (repoName) return repos.find(r => r.name === repoName) || null;
    return repos[0]; // default to first
  };

  // List all registered repos
  app.get('/api/repos', async (_req, res) => {
    try {
      const repos = await listRegisteredRepos();
      res.json(repos.map(r => ({
        name: r.name, path: r.path, indexedAt: r.indexedAt,
        lastCommit: r.lastCommit, stats: r.stats,
      })));
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

  // Get full graph
  app.get('/api/graph', async (req, res) => {
    try {
      const entry = await resolveRepo(requestedRepo(req));
      if (!entry) {
        res.status(404).json({ error: 'Repository not found' });
        return;
      }
      const lbugPath = path.join(entry.storagePath, 'lbug');
      const graph = await withLbugDb(lbugPath, async () => buildGraph());
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

  // Search
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

      const results = await withLbugDb(lbugPath, async () => {
        const { isEmbedderReady } = await import('../core/embeddings/embedder.js');
        if (isEmbedderReady()) {
          const { semanticSearch } = await import('../core/embeddings/embedding-pipeline.js');
          return hybridSearch(query, limit, executeQuery, semanticSearch);
        }
        // FTS-only fallback when embeddings aren't loaded
        return searchFTSFromLbug(query, limit);
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

      const content = await fs.readFile(fullPath, 'utf-8');
      res.json({ content });
    } catch (err: any) {
      if (err.code === 'ENOENT') {
        res.status(404).json({ error: 'File not found' });
      } else {
        res.status(500).json({ error: err.message || 'Failed to read file' });
      }
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
      res.status(statusFromError(err)).json({ error: err.message || 'Failed to query process detail' });
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
      res.status(statusFromError(err)).json({ error: err.message || 'Failed to query cluster detail' });
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

  // Global error handler — catch anything the route handlers miss
  app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error('Unhandled error:', err);
    res.status(500).json({ error: 'Internal server error' });
  });

  const server = app.listen(port, host, () => {
    console.log(`GitNexus server running on http://${host}:${port}`);
  });

  // Graceful shutdown — close Express + LadybugDB cleanly
  const shutdown = async () => {
    server.close();
    await cleanupMcp();
    await closeLbug();
    await backend.disconnect();
    process.exit(0);
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
};
