/**
 * Artifact emitter integration test — contract v0.
 *
 * Runs the real pipeline (worker pool resolves the compiled dist/ parse-worker,
 * same as the resolvers suite — run `node scripts/build.js` first) against the
 * ascend-c-basic fixture and validates the emitted artifact directory against
 * the contract: parseable NDJSON, manifest stats consistent with actual line
 * counts, manifest written as completeness marker, expected graph content.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  emitArtifacts,
  CONTRACT_VERSION,
  ENGINE_VERSION,
  type EmitEvent,
  type EmitStats,
} from '../../../src/export/artifact-emitter.js';

const FIXTURE = path.resolve(__dirname, '..', '..', 'fixtures', 'lang-resolution', 'ascend-c-basic');

const readNdjson = async (filePath: string): Promise<unknown[]> => {
  const raw = await fsp.readFile(filePath, 'utf-8');
  return raw
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line));
};

describe('artifact emitter (contract v0)', () => {
  let outDir: string;
  let stats: EmitStats;
  const events: EmitEvent[] = [];

  beforeAll(async () => {
    outDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'gitnexus-emit-'));
    stats = await emitArtifacts(FIXTURE, outDir, {
      onEvent: (event) => events.push(event),
    });
  }, 120000);

  afterAll(async () => {
    if (outDir) await fsp.rm(outDir, { recursive: true, force: true });
  });

  it('writes all three NDJSON artifacts plus manifest.json', async () => {
    const entries = await fsp.readdir(outDir);
    expect(entries.sort()).toEqual(
      expect.arrayContaining(['chunks.ndjson', 'edges.ndjson', 'manifest.json', 'nodes.ndjson']),
    );
  });

  it('every NDJSON line parses as JSON', async () => {
    // readNdjson JSON.parses every line — a malformed line throws here.
    const nodes = await readNdjson(path.join(outDir, 'nodes.ndjson'));
    const edges = await readNdjson(path.join(outDir, 'edges.ndjson'));
    const chunks = await readNdjson(path.join(outDir, 'chunks.ndjson'));
    expect(nodes.length).toBeGreaterThan(0);
    expect(edges.length).toBeGreaterThan(0);
    expect(chunks.length).toBeGreaterThan(0);
  });

  it('manifest stats match actual artifact line counts', async () => {
    const manifest = JSON.parse(await fsp.readFile(path.join(outDir, 'manifest.json'), 'utf-8'));
    expect(manifest.contractVersion).toBe(CONTRACT_VERSION);
    expect(manifest.engineVersion).toBe(ENGINE_VERSION);
    expect(manifest.repoPath).toBe(FIXTURE);
    expect(typeof manifest.generatedAt).toBe('string');
    expect(Number.isNaN(Date.parse(manifest.generatedAt))).toBe(false);
    // Fixture lives inside the engine git repo, so commit is a 40-hex sha here.
    expect(manifest.commit === null || /^[0-9a-f]{40}$/.test(manifest.commit)).toBe(true);

    const nodes = await readNdjson(path.join(outDir, 'nodes.ndjson'));
    const edges = await readNdjson(path.join(outDir, 'edges.ndjson'));
    const chunks = await readNdjson(path.join(outDir, 'chunks.ndjson'));
    expect(manifest.stats.nodes).toBe(nodes.length);
    expect(manifest.stats.edges).toBe(edges.length);
    expect(manifest.stats.chunks).toBe(chunks.length);
    expect(manifest.stats.files).toBeGreaterThan(0);
    // The returned stats are the same object the manifest persisted.
    expect(manifest.stats).toEqual(stats);
  });

  it('nodes include the kernel_add Function from the ascend-c fixture', async () => {
    const nodes = (await readNdjson(path.join(outDir, 'nodes.ndjson'))) as Array<{
      id: string;
      label: string;
      properties: { name?: string; filePath?: string };
    }>;
    const kernelAdd = nodes.find((n) => n.label === 'Function' && n.properties.name === 'kernel_add');
    expect(kernelAdd).toBeDefined();
    expect(kernelAdd!.properties.filePath).toContain('main.asc');
  });

  it('edges include a CALLS relationship with contract-shaped fields', async () => {
    const edges = (await readNdjson(path.join(outDir, 'edges.ndjson'))) as Array<{
      id: string;
      sourceId: string;
      targetId: string;
      type: string;
      confidence: number;
    }>;
    const calls = edges.filter((e) => e.type === 'CALLS');
    expect(calls.length).toBeGreaterThan(0);
    for (const edge of calls) {
      expect(typeof edge.id).toBe('string');
      expect(typeof edge.sourceId).toBe('string');
      expect(typeof edge.targetId).toBe('string');
      expect(typeof edge.confidence).toBe('number');
    }
  });

  it('chunks reference real nodes and carry contract kinds', async () => {
    const nodes = (await readNdjson(path.join(outDir, 'nodes.ndjson'))) as Array<{ id: string }>;
    const nodeIds = new Set(nodes.map((n) => n.id));
    const chunks = (await readNdjson(path.join(outDir, 'chunks.ndjson'))) as Array<{
      nodeId: string;
      kind: string;
      filePath: string;
      startLine: number;
      endLine: number;
      text: string;
    }>;
    for (const chunk of chunks) {
      expect(nodeIds.has(chunk.nodeId)).toBe(true);
      expect(['ast-function', 'ast-declaration', 'char']).toContain(chunk.kind);
      expect(chunk.text.length).toBeGreaterThan(0);
      expect(chunk.startLine).toBeGreaterThanOrEqual(1);
      expect(chunk.endLine).toBeGreaterThanOrEqual(chunk.startLine);
    }
    // The kernel entry function must be chunked with the ast-function strategy.
    const fnChunk = chunks.find((c) => c.kind === 'ast-function' && c.text.includes('kernel_add'));
    expect(fnChunk).toBeDefined();
  });

  it('emits phase progress events mapped to contract phase names', () => {
    const phases = events.filter((e) => e.event === 'phase');
    expect(phases.length).toBeGreaterThan(0);
    const seen = new Set(phases.map((e) => (e as { phase: string }).phase));
    expect(seen.has('scan')).toBe(true);
    expect(seen.has('parse')).toBe(true);
  });

  it('rejects a non-existent repo path instead of emitting an empty graph', async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'gitnexus-emit-badrepo-'));
    try {
      await expect(
        emitArtifacts(path.join(dir, 'does-not-exist'), path.join(dir, 'out')),
      ).rejects.toThrow(/not a directory/);
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });

  it('--no-chunks omits chunks.ndjson but still writes manifest last', async () => {
    const noChunksDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'gitnexus-emit-nochunks-'));
    try {
      const ncStats = await emitArtifacts(FIXTURE, noChunksDir, { chunks: false });
      const entries = await fsp.readdir(noChunksDir);
      expect(entries).not.toContain('chunks.ndjson');
      expect(entries).toContain('manifest.json');
      const manifest = JSON.parse(
        await fsp.readFile(path.join(noChunksDir, 'manifest.json'), 'utf-8'),
      );
      expect(manifest.stats.chunks).toBe(0);
      expect(ncStats.chunks).toBe(0);
      expect(ncStats.nodes).toBe(stats.nodes);
    } finally {
      await fsp.rm(noChunksDir, { recursive: true, force: true });
    }
  }, 120000);
});
