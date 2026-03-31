/**
 * Backend Interface
 *
 * Shared contract between LocalBackend (runs against local LadybugDB)
 * and RemoteBackend (proxies to a remote GitNexus service via HTTP).
 *
 * server.ts and resources.ts depend only on this interface,
 * enabling service/client separation.
 */

export interface CodebaseContext {
  projectName: string;
  stats: {
    fileCount: number;
    functionCount: number;
    communityCount: number;
    processCount: number;
  };
}

export interface RepoInfo {
  name: string;
  path: string;
  indexedAt: string;
  lastCommit: string;
  stats?: any;
}

export interface Backend {
  /** Initialize the backend (discover repos, health check, etc.) */
  init(): Promise<boolean>;

  /** Graceful shutdown */
  disconnect(): Promise<void>;

  /** Dispatch a tool call by method name */
  callTool(method: string, params: any): Promise<any>;

  /** List all available repositories */
  listRepos(): Promise<RepoInfo[]>;

  /** Resolve a repo by name (or return the default) */
  resolveRepo(
    repoName?: string,
  ): Promise<{ name: string; repoPath: string; lastCommit: string; [key: string]: any }>;

  /** Get cached codebase context (may return null if not loaded) */
  getContext(repoId?: string): CodebaseContext | null;

  /** Query community clusters */
  queryClusters(repoName?: string, limit?: number): Promise<{ clusters: any[] }>;

  /** Query execution processes */
  queryProcesses(repoName?: string, limit?: number): Promise<{ processes: any[] }>;

  /** Get detail for a specific cluster */
  queryClusterDetail(name: string, repoName?: string): Promise<any>;

  /** Get detail for a specific process */
  queryProcessDetail(name: string, repoName?: string): Promise<any>;
}
