import { GraphNode, GraphRelationship, KnowledgeGraph } from '../core/graph/types';

export type PipelinePhase = 'idle' | 'extracting' | 'structure' | 'parsing' | 'imports' | 'calls' | 'heritage' | 'communities' | 'processes' | 'enriching' | 'complete' | 'error';

export interface PipelineProgress {
  phase: PipelinePhase;
  percent: number;
  message: string;
  detail?: string;
  stats?: {
    filesProcessed: number;
    totalFiles: number;
    nodesCreated: number;
  };
}

// Serializable version for Web Worker communication
// Maps and functions cannot be transferred via postMessage
export interface SerializablePipelineResult {
  nodes: GraphNode[];
  relationships: GraphRelationship[];
  fileContents: Record<string, string>;
}
