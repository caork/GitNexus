/**
 * Artifact emitter — contract v0.
 *
 * Runs the full ingestion pipeline against a repo and streams the resulting
 * knowledge graph out as NDJSON artifacts for the aka (Rust) side:
 *
 *   <outDir>/nodes.ndjson    one GraphNode per line (verbatim JSON)
 *   <outDir>/edges.ndjson    one GraphRelationship per line (verbatim JSON)
 *   <outDir>/chunks.ndjson   one embedding chunk per line (optional)
 *   <outDir>/manifest.json   metadata + stats — written LAST (completeness marker)
 *
 * Contract: /docs/contracts/artifacts.md in the aka repo (contractVersion 0).
 * aka treats the artifact dir as complete iff manifest.json exists with a
 * matching contractVersion, so the manifest MUST be the final write.
 *
 * Embeddings are NOT computed here — vectors are aka's job. chunks.ndjson only
 * carries the text slices, produced by the same AST-aware chunker the upstream
 * embedding pipeline uses (`src/core/embeddings/chunker.ts` chunkNode).
 */
import { createWriteStream, type WriteStream } from 'node:fs';
import { promises as fsp } from 'node:fs';
import { once } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';

import type { GraphNode, PipelineProgress } from 'gitnexus-shared';
import { runPipelineFromRepo, type PipelineOptions } from '../core/ingestion/pipeline.js';
import { chunkNode, characterChunk } from '../core/embeddings/chunker.js';
import {
  CHUNKING_RULES,
  CHUNK_MODE_AST_FUNCTION,
  CHUNK_MODE_AST_DECLARATION,
  isEmbeddableLabel,
  isShortLabel,
} from '../core/embeddings/types.js';

const execFileAsync = promisify(execFile);

export const CONTRACT_VERSION = 0;
export const ENGINE_VERSION = '1.6.7+aka.1';

/** Mirrors the upstream chunker defaults (embedding-pipeline chunkSize/overlap). */
const CHUNK_SIZE = 1200;
const CHUNK_OVERLAP = 120;

export interface EmitStats {
  files: number;
  nodes: number;
  edges: number;
  chunks: number;
}

export type EmitEvent =
  | { event: 'phase'; phase: string; current: number; total: number }
  | { event: 'warning'; message: string };

export interface EmitArtifactsOptions {
  /** Write chunks.ndjson (default true). The CLI `--no-chunks` flag disables it. */
  chunks?: boolean;
  /** Progress/warning sink — emit-cli serializes these to stdout as NDJSON. */
  onEvent?: (event: EmitEvent) => void;
  /** Extra options forwarded to runPipelineFromRepo. */
  pipelineOptions?: PipelineOptions;
}

export interface EmitManifest {
  contractVersion: number;
  engineVersion: string;
  repoPath: string;
  commit: string | null;
  generatedAt: string;
  stats: EmitStats;
}

/** Contract chunk row. `kind` follows the upstream chunking strategy per label. */
export interface EmitChunk {
  nodeId: string;
  kind: 'ast-function' | 'ast-declaration' | 'char';
  filePath: string;
  startLine: number;
  endLine: number;
  text: string;
}

// ── Progress mapping ────────────────────────────────────────────────────────

/**
 * Map the shared `PipelineProgress.phase` union onto the contract's pipeline
 * phase names (scan/structure/.../processes). Phases that never emit progress
 * today (markdown, cobol, routes, tools, orm, crossFile, pruneLocalSymbols)
 * simply produce no events; unknown future phases pass through verbatim
 * (contract: additive changes are allowed).
 */
const PHASE_NAME_MAP: Record<string, string> = {
  extracting: 'scan',
  structure: 'structure',
  parsing: 'parse',
  imports: 'crossFile',
  calls: 'crossFile',
  heritage: 'crossFile',
  scopeResolution: 'scopeResolution',
  enriching: 'mro',
  communities: 'communities',
  processes: 'processes',
};

const progressToEvent = (progress: PipelineProgress): EmitEvent | null => {
  if (progress.phase === 'complete' || progress.phase === 'idle') return null;
  if (progress.phase === 'error') {
    const detail = progress.detail ? `: ${progress.detail}` : '';
    return { event: 'warning', message: `${progress.message}${detail}` };
  }
  const phase = PHASE_NAME_MAP[progress.phase] ?? progress.phase;
  if (progress.stats && progress.stats.totalFiles > 0) {
    return {
      event: 'phase',
      phase,
      current: progress.stats.filesProcessed,
      total: progress.stats.totalFiles,
    };
  }
  // No file-level stats on this event — degrade to percent out of 100.
  return { event: 'phase', phase, current: Math.round(progress.percent), total: 100 };
};

// ── NDJSON stream helper ────────────────────────────────────────────────────

/** Write one NDJSON line, respecting backpressure (await drain on a full buffer). */
const writeLine = async (ws: WriteStream, value: unknown): Promise<void> => {
  if (!ws.write(`${JSON.stringify(value)}\n`)) {
    await once(ws, 'drain');
  }
};

const closeStream = async (ws: WriteStream): Promise<void> => {
  ws.end();
  await once(ws, 'close');
};

// ── Chunk emission ──────────────────────────────────────────────────────────

/** Tiny bounded file-content cache — nodes of the same file arrive clustered. */
class FileTextCache {
  private cache = new Map<string, string | null>();
  constructor(
    private repoPath: string,
    private maxSize = 512,
  ) {}

  async get(relativePath: string): Promise<string | null> {
    const hit = this.cache.get(relativePath);
    if (hit !== undefined) return hit;
    let content: string | null = null;
    try {
      content = await fsp.readFile(path.join(this.repoPath, relativePath), 'utf-8');
    } catch {
      content = null; // unreadable/missing file — caller skips the node
    }
    if (this.cache.size >= this.maxSize) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    this.cache.set(relativePath, content);
    return content;
  }
}

const chunkKindForLabel = (label: string): EmitChunk['kind'] => {
  const rule = CHUNKING_RULES[label as keyof typeof CHUNKING_RULES];
  if (rule?.mode === CHUNK_MODE_AST_FUNCTION) return 'ast-function';
  if (rule?.mode === CHUNK_MODE_AST_DECLARATION) return 'ast-declaration';
  return 'char';
};

interface ChunkableNode {
  id: string;
  label: string;
  filePath: string;
  startLine: number;
  endLine: number;
}

const asChunkableNode = (node: GraphNode): ChunkableNode | null => {
  if (!isEmbeddableLabel(node.label)) return null;
  const { filePath, startLine, endLine } = node.properties;
  if (typeof filePath !== 'string' || filePath.length === 0) return null;
  if (typeof startLine !== 'number' || typeof endLine !== 'number') return null;
  if (startLine < 1 || endLine < startLine) return null;
  return { id: node.id, label: node.label, filePath, startLine, endLine };
};

/**
 * Produce contract chunk rows for one symbol node, reusing the upstream
 * AST-aware chunker. Short labels (Const/Property/...) embed as a single
 * chunk; chunkable labels go through `chunkNode` (AST statement/member
 * splitting with character fallback — same path the embedding pipeline runs).
 */
const buildChunksForNode = async (
  node: ChunkableNode,
  source: string,
): Promise<EmitChunk[]> => {
  const lines = source.split('\n');
  if (node.startLine > lines.length) return [];
  const text = lines.slice(node.startLine - 1, Math.min(node.endLine, lines.length)).join('\n');
  if (text.trim().length === 0) return [];

  const kind = chunkKindForLabel(node.label);
  const base = { nodeId: node.id, filePath: node.filePath } as const;

  if (isShortLabel(node.label)) {
    return [{ ...base, kind: 'char', startLine: node.startLine, endLine: node.endLine, text }];
  }

  let pieces: Array<{ text: string; startLine: number; endLine: number }>;
  try {
    pieces = await chunkNode(
      node.label,
      text,
      node.filePath,
      node.startLine,
      node.endLine,
      CHUNK_SIZE,
      CHUNK_OVERLAP,
    );
  } catch {
    pieces = characterChunk(text, node.startLine, node.endLine, CHUNK_SIZE, CHUNK_OVERLAP);
  }

  return pieces.map((piece) => ({
    ...base,
    kind,
    startLine: piece.startLine,
    endLine: piece.endLine,
    text: piece.text,
  }));
};

// ── Manifest helpers ────────────────────────────────────────────────────────

const resolveCommit = async (repoPath: string): Promise<string | null> => {
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: repoPath });
    const sha = stdout.trim();
    return /^[0-9a-f]{40}$/.test(sha) ? sha : null;
  } catch {
    return null; // not a git repo / git unavailable — contract allows null
  }
};

// ── Entry point ─────────────────────────────────────────────────────────────

export const emitArtifacts = async (
  repoPath: string,
  outDir: string,
  options: EmitArtifactsOptions = {},
): Promise<EmitStats> => {
  const emitChunks = options.chunks !== false;
  const onEvent = options.onEvent ?? (() => {});
  const absRepoPath = path.resolve(repoPath);
  const absOutDir = path.resolve(outDir);

  // Exit code 0 means "artifacts are trustworthy" — a typo'd repo path must
  // fail loudly, not silently emit an empty graph.
  const repoStat = await fsp.stat(absRepoPath).catch(() => null);
  if (!repoStat?.isDirectory()) {
    throw new Error(`repo path is not a directory: ${absRepoPath}`);
  }

  await fsp.mkdir(absOutDir, { recursive: true });
  // A stale manifest from a previous run must never mark a half-written
  // artifact dir as complete — drop it before any other write.
  await fsp.rm(path.join(absOutDir, 'manifest.json'), { force: true });
  if (!emitChunks) {
    // Contract: chunks.ndjson is omitted entirely under --no-chunks.
    await fsp.rm(path.join(absOutDir, 'chunks.ndjson'), { force: true });
  }

  const result = await runPipelineFromRepo(
    absRepoPath,
    (progress) => {
      const event = progressToEvent(progress);
      if (event) onEvent(event);
    },
    options.pipelineOptions,
  );
  const { graph } = result;

  const stats: EmitStats = {
    files: result.totalFileCount,
    nodes: graph.nodeCount,
    edges: graph.relationshipCount,
    chunks: 0,
  };

  // nodes.ndjson — GraphNode verbatim, one per line.
  const nodesStream = createWriteStream(path.join(absOutDir, 'nodes.ndjson'), 'utf-8');
  for (const node of graph.iterNodes()) {
    await writeLine(nodesStream, node);
  }
  await closeStream(nodesStream);

  // edges.ndjson — GraphRelationship verbatim, one per line.
  const edgesStream = createWriteStream(path.join(absOutDir, 'edges.ndjson'), 'utf-8');
  for (const rel of graph.iterRelationships()) {
    await writeLine(edgesStream, rel);
  }
  await closeStream(edgesStream);

  // chunks.ndjson — embedding text slices (no vectors; aka computes those).
  if (emitChunks) {
    const chunksStream = createWriteStream(path.join(absOutDir, 'chunks.ndjson'), 'utf-8');
    const fileCache = new FileTextCache(absRepoPath);
    const warnedFiles = new Set<string>();
    for (const node of graph.iterNodes()) {
      const chunkable = asChunkableNode(node);
      if (!chunkable) continue;
      const source = await fileCache.get(chunkable.filePath);
      if (source === null) {
        if (!warnedFiles.has(chunkable.filePath)) {
          warnedFiles.add(chunkable.filePath);
          onEvent({
            event: 'warning',
            message: `chunks: could not read source file ${chunkable.filePath}; its symbols are skipped`,
          });
        }
        continue;
      }
      for (const chunk of await buildChunksForNode(chunkable, source)) {
        await writeLine(chunksStream, chunk);
        stats.chunks += 1;
      }
    }
    await closeStream(chunksStream);
  }

  // manifest.json — LAST write (completeness marker for the aka side).
  const manifest: EmitManifest = {
    contractVersion: CONTRACT_VERSION,
    engineVersion: ENGINE_VERSION,
    repoPath: absRepoPath,
    commit: await resolveCommit(absRepoPath),
    generatedAt: new Date().toISOString(),
    stats,
  };
  await fsp.writeFile(
    path.join(absOutDir, 'manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
    'utf-8',
  );

  return stats;
};
