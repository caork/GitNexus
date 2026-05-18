// gitnexus/src/core/ingestion/method-extractors/configs/ascend-c.ts

/**
 * Ascend C method extraction config.
 *
 * Extends the C++ config with Ascend C–specific annotation extraction.
 * The `extractAnnotations` hook reads from the dual-channel preprocessor's
 * attribute cache to recover `__global__`, `__aicore__`, etc. that were
 * stripped before tree-sitter parsing.
 */

import { SupportedLanguages } from 'gitnexus-shared';
import { cppMethodConfig } from './c-cpp.js';
import { getAscendCAttributesForCurrentFile } from '../../ascend-c-preprocessor.js';
import type { MethodExtractionConfig } from '../../method-types.js';
import type { SyntaxNode } from '../../utils/ast-helpers.js';

/**
 * Extract Ascend C annotations from the preprocessor's attribute cache.
 *
 * `extractAnnotations` only receives the AST node — it has no access to
 * file path or original source. We rely on the fact that `preprocessAscendC`
 * was called on this file moments earlier in the same thread, populating
 * the module-level cache with its attributes.
 *
 * The search window extends a few lines above the node's start position
 * to catch attributes on preceding lines (e.g., `__global__` on the line
 * before the function definition).
 */
function extractAscendCAnnotations(node: SyntaxNode): string[] {
  const startLine = node.startPosition.row + 1; // tree-sitter is 0-based
  const endLine = node.endPosition.row + 1;
  return getAscendCAttributesForCurrentFile(startLine, endLine);
}

export const ascendCMethodConfig: MethodExtractionConfig = {
  ...cppMethodConfig,
  language: SupportedLanguages.AscendC,
  extractAnnotations: extractAscendCAnnotations,
};
