/**
 * Server Mapping Configuration
 *
 * Reads <GITNEXUS_HOME>/server-mapping.json (defaults to ~/.gitnexus/...)
 * to map repo names to service names. Used in embedding text to enrich
 * metadata with microservice context.
 */

import fs from 'fs/promises';
import path from 'path';
import { getGlobalDir } from '../../storage/repo-manager.js';

const getMappingFilePath = (): string => path.join(getGlobalDir(), 'server-mapping.json');

let cachedMapping: Record<string, string> | null = null;

/**
 * Read the server mapping file and return the serverName for a given repoName.
 * Returns undefined if no mapping exists.
 */
export const readServerMapping = async (repoName: string): Promise<string | undefined> => {
  try {
    if (!cachedMapping) {
      const raw = await fs.readFile(getMappingFilePath(), 'utf-8');
      cachedMapping = JSON.parse(raw);
    }
    return cachedMapping[repoName];
  } catch {
    return undefined;
  }
};

/**
 * Clear the cached mapping (useful for testing or after file changes)
 */
export const clearServerMappingCache = (): void => {
  cachedMapping = null;
};
