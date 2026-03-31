import { useCallback, useEffect, useRef } from 'react';
import { AppStateProvider, useAppState } from './hooks/useAppState';
import { DropZone } from './components/DropZone';
import { LoadingOverlay } from './components/LoadingOverlay';
import { Header } from './components/Header';
import { GraphCanvas, GraphCanvasHandle } from './components/GraphCanvas';
import { RightPanel } from './components/RightPanel';
import { SettingsPanel } from './components/SettingsPanel';
import { StatusBar } from './components/StatusBar';
import { FileTreePanel } from './components/FileTreePanel';
import { CodeReferencesPanel } from './components/CodeReferencesPanel';
import { FileEntry } from './services/zip';
import { getActiveProviderConfig } from './core/llm/settings-service';
import { createKnowledgeGraph } from './core/graph/graph';
import { connectToServer, fetchRepos, normalizeServerUrl, type ConnectToServerResult } from './services/server-connection';
import { ERROR_RESET_DELAY_MS } from './config/ui-constants';

const AppContent = () => {
  const {
    viewMode,
    setViewMode,
    setGraph,
    setFileContents,
    setProgress,
    setProjectName,
    progress,
    isRightPanelOpen,
    runPipeline,
    runPipelineFromFiles,
    isSettingsPanelOpen,
    setSettingsPanelOpen,
    refreshLLMSettings,
    initializeAgent,
    startEmbeddingsWithFallback,
    embeddingStatus,
    codeReferences,
    selectedNode,
    isCodePanelOpen,
    serverBaseUrl,
    setServerBaseUrl,
    availableRepos,
    setAvailableRepos,
    switchRepo,
    loadServerGraph,
    isAddRepoOpen,
    setAddRepoOpen,
  } = useAppState();

  const graphCanvasRef = useRef<GraphCanvasHandle>(null);

  // Track whether a local upload (ZIP / git clone) is in progress or completed.
  // When true, auto-connect will NOT override locally loaded data.
  const localDataLoadedRef = useRef(false);

  const handleFileSelect = useCallback(async (file: File) => {
    localDataLoadedRef.current = true; // Mark: user chose local upload
    const projectName = file.name.replace('.zip', '');
    setProjectName(projectName);
    setProgress({ phase: 'extracting', percent: 0, message: 'Starting...', detail: 'Preparing to extract files' });
    setViewMode('loading');

    try {
      const result = await runPipeline(file, (progress) => {
        setProgress(progress);
      });

      setGraph(result.graph);
      setFileContents(result.fileContents);
      setViewMode('exploring');

      // Initialize (or re-initialize) the agent AFTER a repo loads so it captures
      // the current codebase context (file contents + graph tools) in the worker.
      if (getActiveProviderConfig()) {
        initializeAgent(projectName);
      }

      // Auto-start embeddings pipeline in background
      // Uses WebGPU if available, falls back to WASM
      startEmbeddingsWithFallback();
    } catch (error) {
      console.error('Pipeline error:', error);
      setProgress({
        phase: 'error',
        percent: 0,
        message: 'Error processing file',
        detail: error instanceof Error ? error.message : 'Unknown error',
      });
      setTimeout(() => {
        setViewMode('onboarding');
        setProgress(null);
      }, ERROR_RESET_DELAY_MS);
    }
  }, [setViewMode, setGraph, setFileContents, setProgress, setProjectName, runPipeline, startEmbeddingsWithFallback, initializeAgent]);

  const handleGitClone = useCallback(async (files: FileEntry[], repoName?: string) => {
    localDataLoadedRef.current = true; // Mark: user chose local upload
    let projectName = repoName;
    if (!projectName) {
      const firstPath = files[0]?.path || 'repository';
      projectName = firstPath.split('/')[0].replace(/-\d+$/, '') || 'repository';
    }

    setProjectName(projectName);
    setProgress({ phase: 'extracting', percent: 0, message: 'Starting...', detail: 'Preparing to process files' });
    setViewMode('loading');

    try {
      const result = await runPipelineFromFiles(files, (progress) => {
        setProgress(progress);
      });

      setGraph(result.graph);
      setFileContents(result.fileContents);
      setViewMode('exploring');

      if (getActiveProviderConfig()) {
        initializeAgent(projectName);
      }

      startEmbeddingsWithFallback();
    } catch (error) {
      console.error('Pipeline error:', error);
      setProgress({
        phase: 'error',
        percent: 0,
        message: 'Error processing repository',
        detail: error instanceof Error ? error.message : 'Unknown error',
      });
      setTimeout(() => {
        setViewMode('onboarding');
        setProgress(null);
      }, ERROR_RESET_DELAY_MS);
    }
  }, [setViewMode, setGraph, setFileContents, setProgress, setProjectName, runPipelineFromFiles, startEmbeddingsWithFallback, initializeAgent]);

  const handleServerConnect = useCallback((result: ConnectToServerResult): Promise<void> => {
    // Extract project name from repoPath
    const repoPath = result.repoInfo.repoPath;
    const parts = repoPath.split('/').filter(p => p && !p.startsWith('.'));
    const projectName = parts[parts.length - 1] || parts[0] || 'server-project';
    setProjectName(projectName);

    // Build KnowledgeGraph from server data for visualization
    const graph = createKnowledgeGraph();
    for (const node of result.nodes) {
      graph.addNode(node);
    }
    for (const rel of result.relationships) {
      graph.addRelationship(rel);
    }
    setGraph(graph);

    // Set file contents from extracted File node content
    const fileMap = new Map<string, string>();
    for (const [path, content] of Object.entries(result.fileContents)) {
      fileMap.set(path, content);
    }
    setFileContents(fileMap);

    // Transition directly to exploring view
    setViewMode('exploring');

    // Load graph into LadybugDB (in-browser WASM database) for Nexus AI queries,
    // then initialize agent once the database is ready
    const loadGraphPromise = loadServerGraph(result.nodes, result.relationships, result.fileContents)
      .then(() => {
        if (getActiveProviderConfig()) {
          return initializeAgent(projectName);
        }
      })
      .then(() => {
        startEmbeddingsWithFallback();
      })
      .catch((err) => {
        console.warn('Failed to load graph into LadybugDB:', err);
        // Agent won't work but graph visualization still does
      });

    return loadGraphPromise;
  }, [setViewMode, setGraph, setFileContents, setProjectName, loadServerGraph, initializeAgent, startEmbeddingsWithFallback]);

  // Auto-connect: detect server via /api/health (same origin or ?server param).
  // On refresh, reads repo name from URL hash (#repo=Name) to restore session.
  const autoConnectRan = useRef(false);
  useEffect(() => {
    if (autoConnectRan.current) return;
    autoConnectRan.current = true;

    const params = new URLSearchParams(window.location.search);
    const paramUrl = params.get('server');

    // Determine server URL: explicit ?server param, or same origin (Vite proxy)
    const serverUrl = paramUrl || window.location.origin;

    // Read repo name from URL hash (e.g. #repo=GitNexus)
    const hashRepo = window.location.hash.match(/repo=([^&]+)/)?.[1] ?? undefined;

    // Clean ?server param from URL (keep hash)
    if (paramUrl) {
      const cleanUrl = window.location.pathname + window.location.hash;
      window.history.replaceState(null, '', cleanUrl);
    }

    // Probe the server — if it responds, auto-connect
    const baseUrl = normalizeServerUrl(serverUrl);
    fetch(`${baseUrl.replace(/\/api$/, '')}/api/health`)
      .then(r => { if (!r.ok) throw new Error('not ok'); return r.json(); })
      .then((health) => {
        if (!health?.status || health.repos === 0) throw new Error('no repos');
        // Abort if user started a local upload while health check was in-flight
        if (localDataLoadedRef.current) throw new Error('local data loaded');

        setProgress({ phase: 'extracting', percent: 0, message: 'Connecting to server...', detail: 'Loading graph from server' });
        setViewMode('loading');

        return connectToServer(serverUrl, (phase, downloaded, total) => {
          if (phase === 'validating') {
            setProgress({ phase: 'extracting', percent: 5, message: 'Connecting to server...', detail: 'Validating server' });
          } else if (phase === 'downloading') {
            const pct = total ? Math.round((downloaded / total) * 90) + 5 : 50;
            const mb = (downloaded / (1024 * 1024)).toFixed(1);
            setProgress({ phase: 'extracting', percent: pct, message: 'Downloading graph...', detail: `${mb} MB downloaded` });
          } else if (phase === 'extracting') {
            setProgress({ phase: 'extracting', percent: 97, message: 'Processing...', detail: 'Extracting file contents' });
          }
        }, undefined, hashRepo);
      })
      .then(async (result) => {
        // Abort if user started a local upload while server data was downloading
        if (localDataLoadedRef.current) {
          console.log('Auto-connect aborted: local data was loaded by user');
          setProgress(null);
          return;
        }
        await handleServerConnect(result);
        setProgress(null);
        setServerBaseUrl(baseUrl);

        // Set repo name in URL hash for refresh persistence
        const repoName = result.repoInfo?.name ||
          result.repoInfo?.repoPath?.split('/').filter(Boolean).pop() || '';
        if (repoName) {
          window.history.replaceState(null, '', `${window.location.pathname}#repo=${encodeURIComponent(repoName)}`);
        }

        fetchRepos(baseUrl)
          .then((repos) => setAvailableRepos(repos))
          .catch((e) => console.warn('Failed to fetch repo list:', e));
      })
      .catch(() => {
        // Server not available — fall through to onboarding (DropZone)
      });
  }, [handleServerConnect, setProgress, setViewMode, setServerBaseUrl, setAvailableRepos]);

  const handleFocusNode = useCallback((nodeId: string) => {
    graphCanvasRef.current?.focusNode(nodeId);
  }, []);

  // Handle settings saved - refresh and reinitialize agent
  // NOTE: Must be defined BEFORE any conditional returns (React hooks rule)
  const handleSettingsSaved = useCallback(() => {
    refreshLLMSettings();
    initializeAgent();
  }, [refreshLLMSettings, initializeAgent]);

  // Render based on view mode
  if (viewMode === 'onboarding') {
    return (
      <DropZone
        onFileSelect={handleFileSelect}
        onGitClone={handleGitClone}
        onServerConnect={async (result, serverUrl) => {
          await handleServerConnect(result);
          setProgress(null);
          if (serverUrl) {
            const baseUrl = normalizeServerUrl(serverUrl);
            setServerBaseUrl(baseUrl);

            // Set repo name in URL hash for refresh persistence
            const repoName = result.repoInfo?.name ||
              result.repoInfo?.repoPath?.split('/').filter(Boolean).pop() || '';
            if (repoName) {
              window.history.replaceState(null, '', `${window.location.pathname}#repo=${encodeURIComponent(repoName)}`);
            }

            fetchRepos(baseUrl)
              .then((repos) => setAvailableRepos(repos))
              .catch((e) => console.warn('Failed to fetch repo list:', e));
          }
        }}
      />
    );
  }

  if (viewMode === 'loading' && progress) {
    return <LoadingOverlay progress={progress} />;
  }

  // Exploring view
  return (
    <div className="flex flex-col h-screen bg-void overflow-hidden">
      <Header onFocusNode={handleFocusNode} availableRepos={availableRepos} onSwitchRepo={switchRepo} />

      <main className="flex-1 flex min-h-0">
        {/* Left Panel - File Tree */}
        <FileTreePanel onFocusNode={handleFocusNode} />

        {/* Graph area - takes remaining space */}
        <div className="flex-1 relative min-w-0">
          <GraphCanvas ref={graphCanvasRef} />

          {/* Code References Panel (overlay) - does NOT resize the graph, it overlaps on top */}
          {isCodePanelOpen && (codeReferences.length > 0 || !!selectedNode) && (
            <div className="absolute inset-y-0 left-0 z-30 pointer-events-auto">
              <CodeReferencesPanel onFocusNode={handleFocusNode} />
            </div>
          )}
        </div>

        {/* Right Panel - Code & Chat (tabbed) */}
        {isRightPanelOpen && <RightPanel />}
      </main>

      <StatusBar />

      {/* Settings Panel (modal) */}
      <SettingsPanel
        isOpen={isSettingsPanelOpen}
        onClose={() => setSettingsPanelOpen(false)}
        onSettingsSaved={handleSettingsSaved}
      />

      {/* Add Repository modal — full DropZone experience in an overlay */}
      {isAddRepoOpen && (
        <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm overflow-y-auto">
          <button
            className="absolute top-4 right-4 p-2 text-text-muted hover:text-text-primary bg-surface rounded-lg border border-border-subtle transition-colors z-10"
            onClick={() => setAddRepoOpen(false)}
            title="Close"
          >
            ✕
          </button>
          <DropZone
            onFileSelect={async (file) => {
              setAddRepoOpen(false);
              await handleFileSelect(file);
            }}
            onGitClone={async (files, repoName) => {
              setAddRepoOpen(false);
              await handleGitClone(files, repoName);
            }}
            onServerConnect={async (result, serverUrl) => {
              setAddRepoOpen(false);
              await handleServerConnect(result);
              setProgress(null);
              if (serverUrl) {
                const baseUrl = normalizeServerUrl(serverUrl);
                setServerBaseUrl(baseUrl);
                const repoName = result.repoInfo?.name ||
                  result.repoInfo?.repoPath?.split('/').filter(Boolean).pop() || '';
                if (repoName) {
                  window.history.replaceState(null, '', `${window.location.pathname}#repo=${encodeURIComponent(repoName)}`);
                }
                fetchRepos(baseUrl)
                  .then((repos) => setAvailableRepos(repos))
                  .catch((e) => console.warn('Failed to fetch repo list:', e));
              }
            }}
          />
        </div>
      )}

    </div>
  );
};

function App() {
  return (
    <AppStateProvider>
      <AppContent />
    </AppStateProvider>
  );
}

export default App;
