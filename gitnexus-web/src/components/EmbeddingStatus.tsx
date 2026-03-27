import { Brain, Loader2, Check, AlertCircle, Zap } from '@/lib/lucide-icons';
import { useAppState } from '../hooks/useAppState';
import { useState } from 'react';
import { WebGPUFallbackDialog } from './WebGPUFallbackDialog';

/**
 * Embedding status indicator and trigger button
 * Shows in header when graph is loaded
 */
export const EmbeddingStatus = () => {
  const {
    embeddingStatus,
    embeddingProgress,
    startEmbeddings,
    graph,
    viewMode,
    serverBaseUrl,
  } = useAppState();

  const [showFallbackDialog, setShowFallbackDialog] = useState(false);

  // Only show when exploring a loaded graph; hide in backend mode (no WASM DB)
  if (viewMode !== 'exploring' || !graph || serverBaseUrl) return null;

  const nodeCount = graph.nodes.length;

  const handleStartEmbeddings = async (_forceDevice?: 'webgpu' | 'wasm') => {
    try {
      await startEmbeddings();
    } catch (error: any) {
      // Check if it's a WebGPU not available error
      if (error?.name === 'WebGPUNotAvailableError' || 
          error?.message?.includes('WebGPU not available')) {
        setShowFallbackDialog(true);
      } else {
        console.error('Embedding failed:', error);
      }
    }
  };

  const handleUseCPU = () => {
    setShowFallbackDialog(false);
    handleStartEmbeddings('wasm');
  };

  const handleSkipEmbeddings = () => {
    setShowFallbackDialog(false);
    // Just close - user can try again later if they want
  };
  
  // WebGPU fallback dialog - rendered independently of state
  const fallbackDialog = (
    <WebGPUFallbackDialog
      isOpen={showFallbackDialog}
      onClose={() => setShowFallbackDialog(false)}
      onUseCPU={handleUseCPU}
      onSkip={handleSkipEmbeddings}
      nodeCount={nodeCount}
    />
  );

  // Idle state - show button to start
  if (embeddingStatus === 'idle') {
    return (
      <>
        <div className="flex items-center gap-2">
          <button
            onClick={() => handleStartEmbeddings()}
            className="flex items-center gap-2 px-3 py-1.5 bg-surface border border-border-subtle rounded-lg text-sm text-text-secondary hover:bg-hover hover:text-text-primary hover:border-accent/50 transition-all group"
            title="Generate embeddings for semantic search"
          >
            <Brain className="w-4 h-4 text-node-interface group-hover:text-accent transition-colors" />
            <span className="hidden sm:inline">Enable Semantic Search</span>
            <Zap className="w-3 h-3 text-text-muted" />
          </button>
        </div>
        {fallbackDialog}
      </>
    );
  }

  // Loading model
  if (embeddingStatus === 'loading') {
    const downloadPercent = embeddingProgress?.percent ?? 0;
    return (
      <>
        <div className="flex items-center gap-2.5 px-3 py-1.5 bg-surface border border-accent/30 rounded-lg text-sm">
          <Loader2 className="w-4 h-4 text-accent animate-spin" />
          <div className="flex flex-col gap-0.5">
            <span className="text-text-secondary text-xs">Loading AI model...</span>
            <div className="w-24 h-1 bg-elevated rounded-full overflow-hidden">
              <div 
                className="h-full bg-gradient-to-r from-accent to-node-interface rounded-full transition-all duration-300"
                style={{ width: `${downloadPercent}%` }}
              />
            </div>
          </div>
        </div>
        {fallbackDialog}
      </>
    );
  }

  // Embedding in progress
  if (embeddingStatus === 'embedding') {
    const processed = 0;
    const total = 0;
    const percent = embeddingProgress?.percent ?? 0;
    
    return (
      <div className="flex items-center gap-2.5 px-3 py-1.5 bg-surface border border-node-function/30 rounded-lg text-sm">
        <Loader2 className="w-4 h-4 text-node-function animate-spin" />
        <div className="flex flex-col gap-0.5">
          <span className="text-text-secondary text-xs">
            Embedding {processed}/{total} nodes
          </span>
          <div className="w-24 h-1 bg-elevated rounded-full overflow-hidden">
            <div 
              className="h-full bg-gradient-to-r from-node-function to-accent rounded-full transition-all duration-300"
              style={{ width: `${percent}%` }}
            />
          </div>
        </div>
      </div>
    );
  }

  // Indexing
  if (embeddingStatus === 'indexing') {
    return (
      <div className="flex items-center gap-2 px-3 py-1.5 bg-surface border border-node-interface/30 rounded-lg text-sm text-text-secondary">
        <Loader2 className="w-4 h-4 text-node-interface animate-spin" />
        <span className="text-xs">Creating vector index...</span>
      </div>
    );
  }

  // Ready
  if (embeddingStatus === 'ready') {
    return (
      <div 
        className="flex items-center gap-2 px-3 py-1.5 bg-node-function/10 border border-node-function/30 rounded-lg text-sm text-node-function"
        title="Semantic search is ready! Use natural language in the AI chat."
      >
        <Check className="w-4 h-4" />
        <span className="text-xs font-medium">Semantic Ready</span>
      </div>
    );
  }

  // Error
  if (embeddingStatus === 'error') {
    return (
      <>
        <button
          onClick={() => handleStartEmbeddings()}
          className="flex items-center gap-2 px-3 py-1.5 bg-red-500/10 border border-red-500/30 rounded-lg text-sm text-red-400 hover:bg-red-500/20 transition-colors"
          title="Embedding failed. Click to retry."
        >
          <AlertCircle className="w-4 h-4" />
          <span className="text-xs">Failed - Retry</span>
        </button>
        {fallbackDialog}
      </>
    );
  }

  return null;
};

