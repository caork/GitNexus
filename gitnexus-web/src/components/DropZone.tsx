import { useState, useRef } from 'react';
import { Loader2, ArrowRight, Globe, X, Zap } from '@/lib/lucide-icons';
import { connectToServer, type ConnectToServerResult } from '../services/server-connection';
import { startAnalyze, streamAnalyzeProgress, cancelAnalyze, type AnalyzeJobProgress } from '../services/backend';
import { AnalyzeProgress } from './AnalyzeProgress';

interface DropZoneProps {
  onServerConnect?: (result: ConnectToServerResult, serverUrl?: string) => void;
  onServerAnalyze?: (serverUrl: string, repoName: string) => void;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export const DropZone = ({ onServerConnect, onServerAnalyze }: DropZoneProps) => {
  const [error, setError] = useState<string | null>(null);

  // Server connect state
  const [serverUrl, setServerUrl] = useState(() => {
    try {
      return localStorage.getItem('gitnexus-server-url') || '';
    } catch {
      return '';
    }
  });
  const [isConnecting, setIsConnecting] = useState(false);
  const [serverProgress, setServerProgress] = useState<{
    phase: string;
    downloaded: number;
    total: number | null;
  }>({ phase: '', downloaded: 0, total: null });
  const abortControllerRef = useRef<AbortController | null>(null);

  // Analyze state
  const [analyzeUrl, setAnalyzeUrl] = useState('');
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [analyzeProgress, setAnalyzeProgress] = useState<AnalyzeJobProgress>({ phase: 'queued', percent: 0, message: 'Starting...' });
  const analyzeAbortRef = useRef<AbortController | null>(null);
  const analyzeJobIdRef = useRef<string | null>(null);

  const handleAnalyze = async () => {
    if (!analyzeUrl.trim()) return;
    setIsAnalyzing(true);
    setError(null);
    setAnalyzeProgress({ phase: 'queued', percent: 0, message: 'Starting...' });

    try {
      const serverBase = serverUrl.trim() || window.location.origin;
      const { jobId } = await startAnalyze({ url: analyzeUrl.trim() });
      analyzeJobIdRef.current = jobId;

      analyzeAbortRef.current = streamAnalyzeProgress(
        jobId,
        (progress) => setAnalyzeProgress(progress),
        (data) => {
          setIsAnalyzing(false);
          if (onServerAnalyze && data.repoName) {
            onServerAnalyze(serverBase, data.repoName);
          } else if (onServerConnect) {
            connectToServer(serverBase, undefined, undefined, data.repoName)
              .then((result) => onServerConnect(result, serverBase))
              .catch((err) => setError(err instanceof Error ? err.message : 'Failed to load'));
          }
        },
        (errMsg) => {
          setIsAnalyzing(false);
          setError(errMsg);
        },
      );
    } catch (err) {
      setIsAnalyzing(false);
      setError(err instanceof Error ? err.message : 'Failed to start analysis');
    }
  };

  const handleCancelAnalyze = () => {
    analyzeAbortRef.current?.abort();
    if (analyzeJobIdRef.current) {
      cancelAnalyze(analyzeJobIdRef.current).catch(() => {});
      analyzeJobIdRef.current = null;
    }
    setIsAnalyzing(false);
  };

  const handleServerConnect = async () => {
    const urlToUse = serverUrl.trim() || window.location.origin;
    if (!urlToUse) {
      setError('Please enter a server URL');
      return;
    }

    try {
      localStorage.setItem('gitnexus-server-url', serverUrl);
    } catch {}

    setError(null);
    setIsConnecting(true);
    setServerProgress({ phase: 'validating', downloaded: 0, total: null });

    const abortController = new AbortController();
    abortControllerRef.current = abortController;

    try {
      const result = await connectToServer(
        urlToUse,
        (phase, downloaded, total) => {
          setServerProgress({ phase, downloaded, total });
        },
        abortController.signal
      );

      if (onServerConnect) {
        onServerConnect(result, urlToUse);
      }
    } catch (err) {
      if ((err as Error).name === 'AbortError') return;
      const message = err instanceof Error ? err.message : 'Failed to connect to server';
      if (message.includes('Failed to fetch') || message.includes('NetworkError')) {
        setError('Cannot reach server. Check the URL and ensure the server is running.');
      } else {
        setError(message);
      }
    } finally {
      setIsConnecting(false);
      abortControllerRef.current = null;
    }
  };

  const handleCancelConnect = () => {
    abortControllerRef.current?.abort();
    setIsConnecting(false);
  };

  const serverProgressPercent = serverProgress.total
    ? Math.round((serverProgress.downloaded / serverProgress.total) * 100)
    : null;

  return (
    <div className="flex items-center justify-center min-h-screen p-8 bg-void">
      {/* Background gradient effects */}
      <div className="fixed inset-0 pointer-events-none">
        <div className="absolute top-1/4 left-1/4 w-96 h-96 bg-accent/10 rounded-full blur-3xl" />
        <div className="absolute bottom-1/4 right-1/4 w-96 h-96 bg-node-interface/10 rounded-full blur-3xl" />
      </div>

      <div className="relative w-full max-w-lg">
        {/* Error Message */}
        {error && (
          <div className="mb-4 p-3 bg-red-500/10 border border-red-500/30 rounded-xl text-red-400 text-sm text-center">
            {error}
          </div>
        )}

        <div className="p-8 bg-surface border border-border-default rounded-3xl">
          {/* Icon */}
          <div className="mx-auto w-20 h-20 mb-6 flex items-center justify-center bg-gradient-to-br from-accent to-emerald-600 rounded-2xl shadow-lg">
            <Globe className="w-10 h-10 text-white" />
          </div>

          {/* Text */}
          <h2 className="text-xl font-semibold text-text-primary text-center mb-2">
            Connect to Server
          </h2>
          <p className="text-sm text-text-secondary text-center mb-6">
            Load a pre-built knowledge graph from a running GitNexus server
          </p>

          {/* Server URL + Connect */}
          <div className="space-y-3" data-form-type="other">
            <input
              type="url"
              name="server-url-input"
              value={serverUrl}
              onChange={(e) => setServerUrl(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && !isConnecting && handleServerConnect()}
              placeholder={window.location.origin}
              disabled={isConnecting || isAnalyzing}
              autoComplete="off"
              data-lpignore="true"
              data-1p-ignore="true"
              data-form-type="other"
              className="
                w-full px-4 py-3
                bg-elevated border border-border-default rounded-xl
                text-text-primary placeholder-text-muted
                focus:outline-none focus:border-accent focus:ring-1 focus:ring-accent
                disabled:opacity-50 disabled:cursor-not-allowed
                transition-all duration-200
              "
            />

            <div className="flex gap-2">
              <button
                onClick={handleServerConnect}
                disabled={isConnecting || isAnalyzing}
                className="
                  flex-1 flex items-center justify-center gap-2
                  px-4 py-3
                  bg-accent hover:bg-accent/90
                  text-white font-medium rounded-xl
                  disabled:opacity-50 disabled:cursor-not-allowed
                  transition-all duration-200
                "
              >
                {isConnecting ? (
                  <>
                    <Loader2 className="w-5 h-5 animate-spin" />
                    {serverProgress.phase === 'validating'
                      ? 'Validating...'
                      : serverProgress.phase === 'downloading'
                        ? serverProgressPercent !== null
                          ? `Downloading... ${serverProgressPercent}%`
                          : `Downloading... ${formatBytes(serverProgress.downloaded)}`
                        : serverProgress.phase === 'extracting'
                          ? 'Processing...'
                          : 'Connecting...'
                    }
                  </>
                ) : (
                  <>
                    Connect
                    <ArrowRight className="w-5 h-5" />
                  </>
                )}
              </button>

              {isConnecting && (
                <button
                  onClick={handleCancelConnect}
                  className="
                    flex items-center justify-center
                    px-4 py-3
                    bg-red-500/20 hover:bg-red-500/30
                    text-red-400 font-medium rounded-xl
                    transition-all duration-200
                  "
                >
                  <X className="w-5 h-5" />
                </button>
              )}
            </div>
          </div>

          {/* Download progress bar */}
          {isConnecting && serverProgress.phase === 'downloading' && (
            <div className="mt-4">
              <div className="h-2 bg-elevated rounded-full overflow-hidden">
                <div
                  className={`h-full bg-accent transition-all duration-300 ease-out ${
                    serverProgressPercent === null ? 'animate-pulse' : ''
                  }`}
                  style={{
                    width: serverProgressPercent !== null
                      ? `${serverProgressPercent}%`
                      : '100%',
                  }}
                />
              </div>
              {serverProgress.total && (
                <p className="mt-1 text-xs text-text-muted text-center">
                  {formatBytes(serverProgress.downloaded)} / {formatBytes(serverProgress.total)}
                </p>
              )}
            </div>
          )}

          {/* Divider */}
          <div className="mt-6 flex items-center gap-3">
            <div className="flex-1 h-px bg-border-subtle" />
            <span className="text-xs text-text-muted">or analyze a new repo</span>
            <div className="flex-1 h-px bg-border-subtle" />
          </div>

          {/* Analyze section */}
          <div className="mt-4 space-y-3">
            {isAnalyzing ? (
              <AnalyzeProgress progress={analyzeProgress} onCancel={handleCancelAnalyze} />
            ) : (
              <>
                <input
                  type="url"
                  value={analyzeUrl}
                  onChange={(e) => setAnalyzeUrl(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && !isAnalyzing && handleAnalyze()}
                  placeholder="https://github.com/user/repo"
                  disabled={isConnecting}
                  autoComplete="off"
                  data-lpignore="true"
                  data-1p-ignore="true"
                  data-form-type="other"
                  className="
                    w-full px-4 py-3
                    bg-elevated border border-border-default rounded-xl
                    text-text-primary placeholder-text-muted
                    focus:outline-none focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500
                    disabled:opacity-50 disabled:cursor-not-allowed
                    transition-all duration-200
                  "
                />
                <button
                  onClick={handleAnalyze}
                  disabled={!analyzeUrl.trim() || isConnecting}
                  className="
                    w-full flex items-center justify-center gap-2
                    px-4 py-3
                    bg-emerald-600 hover:bg-emerald-500
                    text-white font-medium rounded-xl
                    disabled:opacity-50 disabled:cursor-not-allowed
                    transition-all duration-200
                  "
                >
                  <Zap className="w-5 h-5" />
                  Analyze on Server
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
