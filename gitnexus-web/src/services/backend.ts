/**
 * Stateless HTTP client for the local GitNexus backend server.
 * All functions use fetch() with AbortController timeouts.
 */

// ── Types ──────────────────────────────────────────────────────────────────

export interface BackendRepo {
  name: string;
  path: string;
  indexedAt: string;
  lastCommit: string;
  stats?: {
    files?: number;
    nodes?: number;
    edges?: number;
    communities?: number;
    processes?: number;
  };
}

// ── Configuration ──────────────────────────────────────────────────────────

let backendUrl = 'http://localhost:4747';

export const setBackendUrl = (url: string): void => {
  backendUrl = url.replace(/\/$/, '');
};

export const getBackendUrl = (): string => backendUrl;

// ── Helpers ────────────────────────────────────────────────────────────────

const DEFAULT_TIMEOUT_MS = 10_000;
const PROBE_TIMEOUT_MS = 2_000;

/**
 * Perform a fetch with an AbortController timeout.
 * Throws a cleaner error message on network failures.
 */
const fetchWithTimeout = async (
  url: string,
  init: RequestInit = {},
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<Response> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    return response;
  } catch (error: unknown) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new Error(`Request to ${url} timed out after ${timeoutMs}ms`);
    }
    if (error instanceof TypeError) {
      throw new Error(`Network error reaching GitNexus backend at ${backendUrl}: ${error.message}`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
};

/**
 * Assert the response is OK, otherwise throw with the server's error message if available.
 */
const assertOk = async (response: Response): Promise<void> => {
  if (response.ok) return;

  let message = `Backend returned ${response.status} ${response.statusText}`;
  try {
    const body = await response.json();
    if (body && typeof body.error === 'string') {
      message = body.error;
    }
  } catch {
    // Response body was not JSON — use the status text
  }
  throw new Error(message);
};

// ── API functions ──────────────────────────────────────────────────────────

/**
 * Probe the backend to check if it is reachable.
 * Uses a short 2-second timeout. Returns true if reachable, false otherwise.
 */
export const probeBackend = async (): Promise<boolean> => {
  try {
    const response = await fetchWithTimeout(
      `${backendUrl}/api/repos`,
      {},
      PROBE_TIMEOUT_MS,
    );
    return response.status === 200;
  } catch {
    return false;
  }
};

/**
 * Fetch the list of indexed repositories.
 */
export const fetchRepos = async (): Promise<BackendRepo[]> => {
  const response = await fetchWithTimeout(`${backendUrl}/api/repos`);
  await assertOk(response);
  return response.json() as Promise<BackendRepo[]>;
};

/**
 * Fetch the full graph (nodes + relationships) for a repository.
 */
export const fetchGraph = async (
  repo: string,
): Promise<{ nodes: unknown[]; relationships: unknown[] }> => {
  // Graph loading can take a while for large repos — use 60s timeout
  const response = await fetchWithTimeout(
    `${backendUrl}/api/graph?repo=${encodeURIComponent(repo)}`,
    {},
    60_000,
  );
  await assertOk(response);
  return response.json() as Promise<{ nodes: unknown[]; relationships: unknown[] }>;
};

/**
 * Execute a raw Cypher query against the repository's graph.
 * Unwraps the `{ result }` wrapper returned by the server.
 */
export const runCypherQuery = async (
  repo: string,
  cypher: string,
): Promise<unknown[]> => {
  const response = await fetchWithTimeout(`${backendUrl}/api/query`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cypher, repo }),
  });
  await assertOk(response);

  const body = await response.json();
  if (body && typeof body.error === 'string') {
    throw new Error(body.error);
  }
  return (body.result ?? body) as unknown[];
};

/**
 * Run a semantic search across the repository's graph.
 */
export const runSearch = async (
  repo: string,
  query: string,
  limit?: number,
): Promise<unknown> => {
  const response = await fetchWithTimeout(`${backendUrl}/api/search`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, limit, repo }),
  });
  await assertOk(response);
  return response.json();
};

/**
 * Fetch the source content of a file in a repository.
 */
export const fetchFileContent = async (
  repo: string,
  filePath: string,
): Promise<string> => {
  const response = await fetchWithTimeout(
    `${backendUrl}/api/file?repo=${encodeURIComponent(repo)}&path=${encodeURIComponent(filePath)}`,
  );
  await assertOk(response);

  const body = (await response.json()) as { content: string };
  return body.content;
};

/**
 * Fetch all execution-flow processes for a repository.
 */
export const fetchProcesses = async (repo: string): Promise<unknown> => {
  const response = await fetchWithTimeout(
    `${backendUrl}/api/processes?repo=${encodeURIComponent(repo)}`,
  );
  await assertOk(response);
  return response.json();
};

/**
 * Fetch the detailed step-by-step trace for a single process.
 */
export const fetchProcessDetail = async (
  repo: string,
  name: string,
): Promise<unknown> => {
  const response = await fetchWithTimeout(
    `${backendUrl}/api/process?repo=${encodeURIComponent(repo)}&name=${encodeURIComponent(name)}`,
  );
  await assertOk(response);
  return response.json();
};

/**
 * Fetch all functional-area clusters for a repository.
 */
export const fetchClusters = async (repo: string): Promise<unknown> => {
  const response = await fetchWithTimeout(
    `${backendUrl}/api/clusters?repo=${encodeURIComponent(repo)}`,
  );
  await assertOk(response);
  return response.json();
};

/**
 * Fetch the members of a single cluster.
 */
export const fetchClusterDetail = async (
  repo: string,
  name: string,
): Promise<unknown> => {
  const response = await fetchWithTimeout(
    `${backendUrl}/api/cluster?repo=${encodeURIComponent(repo)}&name=${encodeURIComponent(name)}`,
  );
  await assertOk(response);
  return response.json();
};

// ── Analyze API ──────────────────────────────────────────────────────────

export interface AnalyzeJobProgress {
  phase: string;
  percent: number;
  message: string;
}

export interface AnalyzeJobStatus {
  id: string;
  status: 'queued' | 'cloning' | 'analyzing' | 'loading' | 'complete' | 'failed';
  repoUrl?: string;
  repoPath?: string;
  repoName?: string;
  progress: AnalyzeJobProgress;
  error?: string;
  startedAt: number;
  completedAt?: number;
}

/**
 * Start a server-side analysis job.
 * Returns 202 with { jobId, status }.
 */
export const startAnalyze = async (
  request: { url?: string; path?: string; force?: boolean; embeddings?: boolean },
): Promise<{ jobId: string; status: string }> => {
  const response = await fetchWithTimeout(
    `${backendUrl}/api/analyze`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
    },
    30_000,
  );
  await assertOk(response);
  return response.json() as Promise<{ jobId: string; status: string }>;
};

/**
 * Poll the status of an analysis job.
 */
export const getAnalyzeStatus = async (
  jobId: string,
): Promise<AnalyzeJobStatus> => {
  const response = await fetchWithTimeout(
    `${backendUrl}/api/analyze/${encodeURIComponent(jobId)}`,
  );
  await assertOk(response);
  return response.json() as Promise<AnalyzeJobStatus>;
};

/**
 * Cancel a running analysis job.
 */
export const cancelAnalyze = async (
  jobId: string,
): Promise<void> => {
  const response = await fetchWithTimeout(
    `${backendUrl}/api/analyze/${encodeURIComponent(jobId)}`,
    { method: 'DELETE' },
  );
  await assertOk(response);
};

/**
 * Stream analysis progress via SSE using fetch + ReadableStream.
 * Returns an AbortController to cancel the stream.
 */
export const streamAnalyzeProgress = (
  jobId: string,
  onProgress: (progress: AnalyzeJobProgress) => void,
  onComplete: (data: { repoName?: string }) => void,
  onError: (error: string) => void,
): AbortController => {
  const controller = new AbortController();
  const url = `${backendUrl}/api/analyze/${encodeURIComponent(jobId)}/progress`;

  (async () => {
    try {
      const response = await fetch(url, { signal: controller.signal });
      if (!response.ok) {
        onError(`Server returned ${response.status}`);
        return;
      }

      const reader = response.body?.getReader();
      if (!reader) {
        onError('No response body');
        return;
      }

      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        // Parse SSE events from buffer
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        let eventType = 'message';
        for (const line of lines) {
          if (line.startsWith('event: ')) {
            eventType = line.slice(7).trim();
          } else if (line.startsWith('data: ')) {
            try {
              const parsed = JSON.parse(line.slice(6));
              if (eventType === 'complete') {
                onComplete(parsed);
                return;
              } else if (eventType === 'failed') {
                onError(parsed.error || 'Analysis failed');
                return;
              } else {
                onProgress(parsed);
              }
            } catch {
              // Skip malformed JSON
            }
            eventType = 'message';
          }
        }
      }
    } catch (err: unknown) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      onError(err instanceof Error ? err.message : 'Stream error');
    }
  })();

  return controller;
};
