/**
 * Embedder Module (HTTP-only)
 *
 * All embeddings are computed via an external OpenAI-compatible API.
 * Local model downloading and inference have been removed.
 * Configure the embedding endpoint via:
 *   - API: PUT /api/config/embedding
 *   - Config: ~/.gitnexus/config.json (embedding section)
 *   - Env: GITNEXUS_EMBEDDING_URL + GITNEXUS_EMBEDDING_MODEL
 */

import { DEFAULT_EMBEDDING_CONFIG } from './types.js';
import { isHttpMode, getHttpDimensions, httpEmbed } from './http-client.js';

/**
 * Check if the embedder is ready (HTTP endpoint configured)
 */
export const isEmbedderReady = (): boolean => {
  return isHttpMode();
};

/**
 * Get the effective embedding dimensions from HTTP config.
 */
export const getEmbeddingDimensions = (): number => {
  return getHttpDimensions() ?? DEFAULT_EMBEDDING_CONFIG.dimensions;
};

/**
 * Embed a single text string via external API
 */
export const embedText = async (text: string): Promise<Float32Array> => {
  if (!isHttpMode()) {
    throw new Error(
      'Embedding endpoint not configured. ' +
      'Set via API: PUT /api/config/embedding {url, model, apiKey, dimensions} ' +
      'or env: GITNEXUS_EMBEDDING_URL + GITNEXUS_EMBEDDING_MODEL'
    );
  }
  const [vec] = await httpEmbed([text]);
  return vec;
};

/**
 * Embed multiple texts in a single batch via external API
 */
export const embedBatch = async (texts: string[]): Promise<Float32Array[]> => {
  if (texts.length === 0) return [];

  if (!isHttpMode()) {
    throw new Error(
      'Embedding endpoint not configured. ' +
      'Set via API: PUT /api/config/embedding {url, model, apiKey, dimensions} ' +
      'or env: GITNEXUS_EMBEDDING_URL + GITNEXUS_EMBEDDING_MODEL'
    );
  }
  return httpEmbed(texts);
};

/**
 * Convert Float32Array to regular number array (for LadybugDB storage)
 */
export const embeddingToArray = (embedding: Float32Array): number[] => {
  return Array.from(embedding);
};

/**
 * No-op — no local resources to clean up in HTTP-only mode
 */
export const disposeEmbedder = async (): Promise<void> => {};
