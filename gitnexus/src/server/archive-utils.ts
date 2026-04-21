/**
 * Archive extraction utilities for the upload endpoint.
 */

import fs from 'fs/promises';
import path from 'path';
import { extract as tarExtract } from 'tar';
import { execFile } from 'child_process';

export const ALLOWED_EXTENSIONS = ['.zip', '.tar', '.tar.gz', '.tgz'];
export const MAX_FILE_SIZE = 500 * 1024 * 1024; // 500 MB

/**
 * Match the file extension against the allowed archive types.
 * Returns the matched extension or null if not supported.
 */
export function getArchiveExtension(filename: string): string | null {
  const lower = filename.toLowerCase();
  if (lower.endsWith('.tar.gz')) return '.tar.gz';
  if (lower.endsWith('.tgz')) return '.tgz';
  if (lower.endsWith('.tar')) return '.tar';
  if (lower.endsWith('.zip')) return '.zip';
  return null;
}

/**
 * Extract an archive file to the given destination directory.
 * Supports .zip (via system `unzip`), .tar, .tar.gz, .tgz (via node-tar).
 */
export async function extractArchive(
  filePath: string,
  destDir: string,
  ext: string,
): Promise<void> {
  await fs.mkdir(destDir, { recursive: true });

  if (ext === '.zip') {
    await new Promise<void>((resolve, reject) => {
      execFile('unzip', ['-o', '-q', filePath, '-d', destDir], (err) => {
        if (err) reject(new Error(`Failed to extract zip: ${err.message}`));
        else resolve();
      });
    });
  } else {
    await tarExtract({ file: filePath, cwd: destDir });
  }
}

/**
 * Find the actual project root inside an extracted directory.
 * Archives often contain a single top-level folder — unwrap it.
 */
export async function findProjectRoot(extractDir: string): Promise<string> {
  const entries = await fs.readdir(extractDir, { withFileTypes: true });
  const dirs = entries.filter((e) => e.isDirectory() && !e.name.startsWith('.'));
  const files = entries.filter((e) => e.isFile());

  // If there's exactly one directory and no files, unwrap it
  if (dirs.length === 1 && files.length === 0) {
    return path.join(extractDir, dirs[0].name);
  }
  return extractDir;
}
