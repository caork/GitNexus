/**
 * Remote Backend
 *
 * Thin HTTP proxy implementing the Backend interface.
 * Forwards all tool calls and resource queries to a remote
 * GitNexus service (started via `gitnexus serve`).
 *
 * Used on developer machines that only need to query a centrally
 * indexed codebase — no local LadybugDB or Tree-sitter needed.
 */

import type { Backend, CodebaseContext, RepoInfo } from '../backend.js';

const REQUEST_TIMEOUT_MS = 30_000;

export class RemoteBackend implements Backend {
  private serverUrl: string;
  private cachedRepos: RepoInfo[] = [];
  private cachedContexts: Map<string, CodebaseContext> = new Map();

  constructor(serverUrl: string) {
    // Normalize: strip trailing slash
    this.serverUrl = serverUrl.replace(/\/+$/, '');
  }

  // ─── Lifecycle ────────────────────────────────────────────────────

  async init(): Promise<boolean> {
    const health = await this.fetchJSON<{ status: string; repos: number }>('GET', '/api/health');
    if (health.status !== 'ok') {
      throw new Error(`GitNexus service unhealthy: ${JSON.stringify(health)}`);
    }

    // Pre-cache repos and context
    this.cachedRepos = await this.fetchJSON<RepoInfo[]>('GET', '/api/repos');

    // Pre-cache context for each repo
    for (const repo of this.cachedRepos) {
      try {
        const info = await this.fetchJSON<{ context: CodebaseContext | null }>('POST', '/api/internal/context-info', { repoName: repo.name });
        if (info.context) {
          this.cachedContexts.set(repo.name.toLowerCase(), info.context);
        }
      } catch {
        // Non-fatal: context may not be available for all repos
      }
    }

    return this.cachedRepos.length > 0;
  }

  async disconnect(): Promise<void> {
    // No-op — no local resources to clean up
  }

  // ─── Tool dispatch ────────────────────────────────────────────────

  async callTool(method: string, params: any): Promise<any> {
    const data = await this.fetchJSON<{ result: any }>('POST', `/api/tools/${encodeURIComponent(method)}`, params ?? {});
    return data.result;
  }

  // ─── Repo discovery ───────────────────────────────────────────────

  async listRepos(): Promise<RepoInfo[]> {
    this.cachedRepos = await this.fetchJSON<RepoInfo[]>('GET', '/api/repos');
    return this.cachedRepos;
  }

  async resolveRepo(repoName?: string): Promise<{ name: string; repoPath: string; lastCommit: string; [key: string]: any }> {
    if (this.cachedRepos.length === 0) {
      await this.listRepos();
    }

    let repo: RepoInfo | undefined;
    if (repoName) {
      repo = this.cachedRepos.find(r => r.name === repoName || r.name.toLowerCase() === repoName.toLowerCase());
      if (!repo) throw new Error(`Repository "${repoName}" not found on remote service`);
    } else {
      if (this.cachedRepos.length === 0) throw new Error('No indexed repositories on remote service');
      if (this.cachedRepos.length > 1) throw new Error(`Multiple repositories indexed. Specify one: ${this.cachedRepos.map(r => r.name).join(', ')}`);
      repo = this.cachedRepos[0];
    }

    return {
      name: repo.name,
      repoPath: repo.path,
      lastCommit: repo.lastCommit,
      indexedAt: repo.indexedAt,
      stats: repo.stats,
    };
  }

  // ─── Context (synchronous, from cache) ────────────────────────────

  getContext(repoId?: string): CodebaseContext | null {
    if (repoId) {
      return this.cachedContexts.get(repoId.toLowerCase()) || null;
    }
    // Return first available
    const first = this.cachedContexts.values().next();
    return first.done ? null : first.value;
  }

  // ─── Resource-backing queries ─────────────────────────────────────

  async queryClusters(repoName?: string, limit?: number): Promise<{ clusters: any[] }> {
    return this.fetchJSON('POST', '/api/internal/clusters', { repoName, limit });
  }

  async queryProcesses(repoName?: string, limit?: number): Promise<{ processes: any[] }> {
    return this.fetchJSON('POST', '/api/internal/processes', { repoName, limit });
  }

  async queryClusterDetail(name: string, repoName?: string): Promise<any> {
    return this.fetchJSON('POST', '/api/internal/cluster-detail', { name, repoName });
  }

  async queryProcessDetail(name: string, repoName?: string): Promise<any> {
    return this.fetchJSON('POST', '/api/internal/process-detail', { name, repoName });
  }

  // ─── HTTP helper ──────────────────────────────────────────────────

  private async fetchJSON<T>(method: 'GET' | 'POST', path: string, body?: any): Promise<T> {
    const url = `${this.serverUrl}${path}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const options: RequestInit = {
        method,
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
      };
      if (method === 'POST' && body !== undefined) {
        options.body = JSON.stringify(body);
      }

      const res = await fetch(url, options);

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        let errorMsg: string;
        try {
          const parsed = JSON.parse(text);
          errorMsg = parsed.error || text;
        } catch {
          errorMsg = text || `HTTP ${res.status}`;
        }
        throw new Error(errorMsg);
      }

      return await res.json() as T;
    } catch (err: any) {
      if (err.name === 'AbortError') {
        throw new Error(`Request to GitNexus service timed out (${REQUEST_TIMEOUT_MS / 1000}s): ${method} ${path}`);
      }
      if (err.cause?.code === 'ECONNREFUSED') {
        throw new Error(`Cannot connect to GitNexus service at ${this.serverUrl}. Is it running? Start with: gitnexus serve --host 0.0.0.0`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
}
