/**
 * Ontology Manager
 *
 * Loads, saves, and serves the Ontology Schema.
 * Uses the default schema as a base, with optional user overrides
 * persisted to ~/.gitnexus/ontology.json.
 */

import fs from 'fs/promises';
import path from 'path';
import type { OntologySchema } from './ontology-schema.js';
import { DEFAULT_ONTOLOGY } from './default-ontology.js';
import { getGlobalDir } from '../../storage/repo-manager.js';

const ONTOLOGY_FILENAME = 'ontology.json';

const getOntologyPath = (): string => path.join(getGlobalDir(), ONTOLOGY_FILENAME);

/**
 * Load the active ontology schema.
 * Returns user-customized schema if saved, otherwise the default.
 */
export const loadOntology = async (): Promise<OntologySchema> => {
  try {
    const raw = await fs.readFile(getOntologyPath(), 'utf-8');
    return JSON.parse(raw) as OntologySchema;
  } catch {
    return DEFAULT_ONTOLOGY;
  }
};

/**
 * Save a customized ontology schema to disk.
 */
export const saveOntology = async (schema: OntologySchema): Promise<void> => {
  const dir = getGlobalDir();
  await fs.mkdir(dir, { recursive: true });
  const filePath = getOntologyPath();
  await fs.writeFile(filePath, JSON.stringify(schema, null, 2), 'utf-8');
  if (process.platform !== 'win32') {
    try { await fs.chmod(filePath, 0o644); } catch { /* best-effort */ }
  }
};

/**
 * Reset ontology to the built-in default (deletes user customization).
 */
export const resetOntology = async (): Promise<OntologySchema> => {
  try {
    await fs.unlink(getOntologyPath());
  } catch { /* file may not exist */ }
  return DEFAULT_ONTOLOGY;
};

/**
 * Check if a user-customized ontology exists.
 */
export const hasCustomOntology = async (): Promise<boolean> => {
  try {
    await fs.access(getOntologyPath());
    return true;
  } catch {
    return false;
  }
};

/**
 * Get the default (built-in) ontology without any user customizations.
 */
export const getDefaultOntology = (): OntologySchema => DEFAULT_ONTOLOGY;

/**
 * Resolve a GitNexus NodeLabel to its Object Type apiName.
 * Returns undefined if the label is not mapped.
 */
export const resolveObjectType = (schema: OntologySchema, nodeLabel: string): string | undefined => {
  for (const ot of schema.objectTypes) {
    if (ot.sourceLabels.includes(nodeLabel)) return ot.apiName;
  }
  return undefined;
};

/**
 * Resolve a GitNexus RelationshipType to its Link Type apiName.
 * Returns undefined if the rel type is not mapped.
 */
export const resolveLinkType = (schema: OntologySchema, relType: string): string | undefined => {
  for (const lt of schema.linkTypes) {
    if (lt.sourceRelType === relType) return lt.apiName;
  }
  return undefined;
};

/**
 * Get all interfaces that an Object Type implements (including inherited).
 */
export const getInterfacesForType = (schema: OntologySchema, objectTypeApiName: string): string[] => {
  const ot = schema.objectTypes.find(t => t.apiName === objectTypeApiName);
  if (!ot) return [];

  const result = new Set<string>();
  const queue = [...ot.interfaces];

  while (queue.length > 0) {
    const ifaceName = queue.pop()!;
    if (result.has(ifaceName)) continue;
    result.add(ifaceName);

    const iface = schema.interfaces.find(i => i.apiName === ifaceName);
    if (iface?.extends) {
      queue.push(...iface.extends);
    }
  }

  return Array.from(result);
};
