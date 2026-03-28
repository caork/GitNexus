/**
 * HTTP Embedding Client
 *
 * Shared fetch+retry logic for OpenAI-compatible /v1/embeddings endpoints.
 * Imported by both the core embedder (batch) and MCP embedder (query).
 *
 * Configuration priority (highest wins):
 *   1. Environment variables: GITNEXUS_EMBEDDING_URL, GITNEXUS_EMBEDDING_MODEL, etc.
 *   2. Persistent config: ~/.gitnexus/config.json → embedding section
 *   3. Programmatic override: setEmbeddingConfig()
 */

import { loadCLIConfig, type EmbeddingConfig as StoredEmbeddingConfig } from '../../storage/repo-manager.js';

const HTTP_TIMEOUT_MS = 30_000;
const HTTP_MAX_RETRIES = 2;
const HTTP_RETRY_BACKOFF_MS = 1_000;
const HTTP_BATCH_SIZE = 64;
const DEFAULT_DIMS = 384;

interface HttpConfig {
  baseUrl: string;
  model: string;
  apiKey: string;
  dimensions?: number;
}

/** In-memory override — set by setEmbeddingConfig() or API endpoint */
let _configOverride: StoredEmbeddingConfig | null = null;

/**
 * Programmatically set embedding config (e.g., from an API call).
 * Takes effect immediately for all subsequent embed calls.
 * Pass null to clear the override and fall back to env/config.json.
 */
export const setEmbeddingConfig = (config: StoredEmbeddingConfig | null): void => {
  _configOverride = config;
};

/**
 * Get the currently active embedding config (for display/API responses).
 */
export const getActiveEmbeddingConfig = async (): Promise<StoredEmbeddingConfig | null> => {
  const resolved = await readConfig();
  if (!resolved) return null;
  return {
    url: resolved.baseUrl,
    model: resolved.model,
    apiKey: resolved.apiKey,
    dimensions: resolved.dimensions,
  };
};

/**
 * Build config by merging sources: in-memory override > env vars > config.json.
 * Returns null when no embedding endpoint is configured anywhere.
 */
const readConfig = async (): Promise<HttpConfig | null> => {
  // Source 1: Environment variables (highest priority)
  const envUrl = process.env.GITNEXUS_EMBEDDING_URL;
  const envModel = process.env.GITNEXUS_EMBEDDING_MODEL;

  if (envUrl && envModel) {
    return {
      baseUrl: envUrl.replace(/\/+$/, ''),
      model: envModel,
      apiKey: process.env.GITNEXUS_EMBEDDING_API_KEY ?? 'unused',
      dimensions: parseDims(process.env.GITNEXUS_EMBEDDING_DIMS),
    };
  }

  // Source 2: In-memory override (from API call)
  if (_configOverride?.url && _configOverride?.model) {
    return {
      baseUrl: _configOverride.url.replace(/\/+$/, ''),
      model: _configOverride.model,
      apiKey: _configOverride.apiKey ?? 'unused',
      dimensions: _configOverride.dimensions,
    };
  }

  // Source 3: Persistent config (~/.gitnexus/config.json)
  try {
    const cliConfig = await loadCLIConfig();
    const emb = cliConfig.embedding;
    if (emb?.url && emb?.model) {
      return {
        baseUrl: emb.url.replace(/\/+$/, ''),
        model: emb.model,
        apiKey: emb.apiKey ?? 'unused',
        dimensions: emb.dimensions,
      };
    }
  } catch {
    // Config file unreadable — fall through
  }

  return null;
};

/** Synchronous version for isHttpMode() — checks env + override + cached config */
let _cachedFileConfig: StoredEmbeddingConfig | undefined;
let _cachedFileConfigLoaded = false;

const readConfigSync = (): HttpConfig | null => {
  const envUrl = process.env.GITNEXUS_EMBEDDING_URL;
  const envModel = process.env.GITNEXUS_EMBEDDING_MODEL;
  if (envUrl && envModel) {
    return {
      baseUrl: envUrl.replace(/\/+$/, ''),
      model: envModel,
      apiKey: process.env.GITNEXUS_EMBEDDING_API_KEY ?? 'unused',
      dimensions: parseDims(process.env.GITNEXUS_EMBEDDING_DIMS),
    };
  }

  if (_configOverride?.url && _configOverride?.model) {
    return {
      baseUrl: _configOverride.url.replace(/\/+$/, ''),
      model: _configOverride.model,
      apiKey: _configOverride.apiKey ?? 'unused',
      dimensions: _configOverride.dimensions,
    };
  }

  if (_cachedFileConfig?.url && _cachedFileConfig?.model) {
    return {
      baseUrl: _cachedFileConfig.url.replace(/\/+$/, ''),
      model: _cachedFileConfig.model,
      apiKey: _cachedFileConfig.apiKey ?? 'unused',
      dimensions: _cachedFileConfig.dimensions,
    };
  }

  return null;
};

/** Warm the file config cache (call during init) */
export const warmConfigCache = async (): Promise<void> => {
  if (_cachedFileConfigLoaded) return;
  try {
    const cliConfig = await loadCLIConfig();
    _cachedFileConfig = cliConfig.embedding;
  } catch { /* ignore */ }
  _cachedFileConfigLoaded = true;
};

const parseDims = (raw: string | undefined): number | undefined => {
  if (raw === undefined) return undefined;
  const parsed = parseInt(raw, 10);
  if (Number.isNaN(parsed) || parsed <= 0) {
    throw new Error(
      `GITNEXUS_EMBEDDING_DIMS must be a positive integer, got "${raw}"`,
    );
  }
  return parsed;
};

/**
 * Check whether HTTP embedding mode is active (env vars / config set).
 * Synchronous — uses cached file config. Call warmConfigCache() during init.
 */
export const isHttpMode = (): boolean => readConfigSync() !== null;

/**
 * Return the configured embedding dimensions for HTTP mode, or undefined
 * if HTTP mode is not active or no explicit dimensions are set.
 */
export const getHttpDimensions = (): number | undefined => readConfigSync()?.dimensions;

/**
 * Return a safe representation of a URL for error messages.
 * Strips query string (may contain tokens) and userinfo.
 */
const safeUrl = (url: string): string => {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}${u.pathname}`;
  } catch {
    return '<invalid-url>';
  }
};

interface EmbeddingItem {
  embedding: number[];
}

/**
 * Send a single batch of texts to the embedding endpoint with retry.
 *
 * @param url - Full endpoint URL (e.g. https://host/v1/embeddings)
 * @param batch - Texts to embed
 * @param model - Model name for the request body
 * @param apiKey - Bearer token (only used in Authorization header)
 * @param batchIndex - Logical batch number (for error context)
 * @param attempt - Current retry attempt (internal)
 */
const httpEmbedBatch = async (
  url: string,
  batch: string[],
  model: string,
  apiKey: string,
  batchIndex = 0,
  attempt = 0,
): Promise<EmbeddingItem[]> => {
  let resp: Response;
  try {
    resp = await fetch(url, {
      method: 'POST',
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ input: batch, model }),
    });
  } catch (err) {
    // Timeouts should not be retried — the server is unresponsive.
    // AbortSignal.timeout() throws DOMException with name 'TimeoutError'.
    const isTimeout = err instanceof DOMException && err.name === 'TimeoutError';
    if (isTimeout) {
      throw new Error(
        `Embedding request timed out after ${HTTP_TIMEOUT_MS}ms (${safeUrl(url)}, batch ${batchIndex})`,
      );
    }
    // DNS, connection errors — retry with backoff
    if (attempt < HTTP_MAX_RETRIES) {
      const delay = HTTP_RETRY_BACKOFF_MS * (attempt + 1);
      await new Promise(r => setTimeout(r, delay));
      return httpEmbedBatch(url, batch, model, apiKey, batchIndex, attempt + 1);
    }
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Embedding request failed (${safeUrl(url)}, batch ${batchIndex}): ${reason}`,
    );
  }

  if (!resp.ok) {
    const status = resp.status;
    if ((status === 429 || status >= 500) && attempt < HTTP_MAX_RETRIES) {
      const delay = HTTP_RETRY_BACKOFF_MS * (attempt + 1);
      await new Promise(r => setTimeout(r, delay));
      return httpEmbedBatch(url, batch, model, apiKey, batchIndex, attempt + 1);
    }
    throw new Error(
      `Embedding endpoint returned ${status} (${safeUrl(url)}, batch ${batchIndex})`,
    );
  }

  const data = (await resp.json()) as { data: EmbeddingItem[] };
  return data.data;
};

/**
 * Embed texts via the HTTP backend, splitting into batches.
 * Reads config from env vars on every call.
 *
 * @param texts - Array of texts to embed
 * @returns Array of Float32Array embedding vectors
 */
export const httpEmbed = async (texts: string[]): Promise<Float32Array[]> => {
  if (texts.length === 0) return [];

  const config = await readConfig();
  if (!config) throw new Error('HTTP embedding not configured');

  const url = `${config.baseUrl}/embeddings`;
  const allVectors: Float32Array[] = [];

  for (let i = 0; i < texts.length; i += HTTP_BATCH_SIZE) {
    const batch = texts.slice(i, i + HTTP_BATCH_SIZE);
    const batchIndex = Math.floor(i / HTTP_BATCH_SIZE);
    const items = await httpEmbedBatch(url, batch, config.model, config.apiKey, batchIndex);

    if (items.length !== batch.length) {
      throw new Error(
        `Embedding endpoint returned ${items.length} vectors for ${batch.length} texts ` +
        `(${safeUrl(url)}, batch ${batchIndex})`,
      );
    }

    for (const item of items) {
      const vec = new Float32Array(item.embedding);
      // Fail fast on dimension mismatch rather than inserting bad vectors
      // into the FLOAT[N] column which would cause a cryptic Kuzu error.
      const expected = config.dimensions ?? DEFAULT_DIMS;
      if (vec.length !== expected) {
        const hint = config.dimensions
          ? 'Update GITNEXUS_EMBEDDING_DIMS to match your model output.'
          : `Set GITNEXUS_EMBEDDING_DIMS=${vec.length} to match your model output.`;
        throw new Error(
          `Embedding dimension mismatch: endpoint returned ${vec.length}d vector, ` +
          `but expected ${expected}d. ${hint}`,
        );
      }

      allVectors.push(vec);
    }
  }

  return allVectors;
};

/**
 * Embed a single query text via the HTTP backend.
 * Convenience for MCP search where only one vector is needed.
 *
 * @param text - Query text to embed
 * @returns Embedding vector as number array
 */
export const httpEmbedQuery = async (text: string): Promise<number[]> => {
  const config = await readConfig();
  if (!config) throw new Error('HTTP embedding not configured');

  const url = `${config.baseUrl}/embeddings`;
  const items = await httpEmbedBatch(url, [text], config.model, config.apiKey);
  if (!items.length) {
    throw new Error(`Embedding endpoint returned empty response (${safeUrl(url)})`);
  }

  const embedding = items[0].embedding;
  // Same dimension checks as httpEmbed — catch mismatches before they
  // reach the Kuzu FLOAT[N] cast in search queries.
  const expected = config.dimensions ?? DEFAULT_DIMS;
  if (embedding.length !== expected) {
    const hint = config.dimensions
      ? 'Update GITNEXUS_EMBEDDING_DIMS to match your model output.'
      : `Set GITNEXUS_EMBEDDING_DIMS=${embedding.length} to match your model output.`;
    throw new Error(
      `Embedding dimension mismatch: endpoint returned ${embedding.length}d vector, ` +
      `but expected ${expected}d. ${hint}`,
    );
  }
  return embedding;
};
