/**
 * Embedder Module (Read-Only, HTTP-only)
 *
 * For MCP queries, embeds search text via external API.
 * Local model downloading has been removed — all inference
 * goes through the configured HTTP embedding endpoint.
 */

import { isHttpMode, getHttpDimensions, httpEmbedQuery } from '../../core/embeddings/http-client.js';

/**
 * Check if embedder is ready (HTTP endpoint configured)
 */
export const isEmbedderReady = (): boolean => isHttpMode();

/**
 * Embed a query text for semantic search via external API
 */
export const embedQuery = async (query: string): Promise<number[]> => {
  if (!isHttpMode()) {
    throw new Error(
      'Embedding endpoint not configured. ' +
      'Set via API: PUT /api/config/embedding or env: GITNEXUS_EMBEDDING_URL + GITNEXUS_EMBEDDING_MODEL'
    );
  }
  return httpEmbedQuery(query);
};

/**
 * Get embedding dimensions from HTTP config
 */
export const getEmbeddingDims = (): number => {
  return getHttpDimensions() ?? 384;
};

/**
 * No-op — no local resources to clean up
 */
export const disposeEmbedder = async (): Promise<void> => {};
