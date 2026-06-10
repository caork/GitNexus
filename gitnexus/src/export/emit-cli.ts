/**
 * emit-cli — contract v0 CLI entry for the artifact emitter.
 *
 * Usage:
 *   tsx src/export/emit-cli.ts --repo <path> --out <dir> [--no-chunks]
 *
 * stdout  — machine channel: NDJSON progress events, one per line
 *             {"event":"phase","phase":"parse","current":12,"total":90}
 *             {"event":"warning","message":"..."}
 *             {"event":"done","stats":{"files":..,"nodes":..,"edges":..,"chunks":..}}
 * stderr  — human-readable logs only (aka never parses it)
 * exit 0  — success, artifact dir complete (manifest.json written last)
 * exit ≠0 — failure, artifact dir must be treated as untrusted
 */
import { parseArgs } from 'node:util';

import { emitArtifacts, type EmitEvent, type EmitStats } from './artifact-emitter.js';

const usage =
  'Usage: emit-cli --repo <repoPath> --out <artifactDir> [--no-chunks]';

const printEvent = (event: EmitEvent | { event: 'done'; stats: EmitStats }): void => {
  process.stdout.write(`${JSON.stringify(event)}\n`);
};

const main = async (): Promise<number> => {
  let values: { repo?: string; out?: string; chunks?: boolean };
  try {
    ({ values } = parseArgs({
      options: {
        repo: { type: 'string' },
        out: { type: 'string' },
        // --no-chunks → chunks=false (parseArgs allowNegative)
        chunks: { type: 'boolean', default: true },
      },
      allowNegative: true,
    }));
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n${usage}\n`);
    return 2;
  }

  if (!values.repo || !values.out) {
    process.stderr.write(`${usage}\n`);
    return 2;
  }

  process.stderr.write(
    `[emit] repo=${values.repo} out=${values.out} chunks=${values.chunks !== false}\n`,
  );

  const startedAt = Date.now();
  const stats = await emitArtifacts(values.repo, values.out, {
    chunks: values.chunks,
    onEvent: printEvent,
  });

  printEvent({ event: 'done', stats });
  process.stderr.write(
    `[emit] done in ${((Date.now() - startedAt) / 1000).toFixed(1)}s — ` +
      `${stats.files} files, ${stats.nodes} nodes, ${stats.edges} edges, ${stats.chunks} chunks\n`,
  );
  return 0;
};

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    process.stderr.write(`[emit] failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
    process.exitCode = 1;
  });
