import type { GraphNode, GraphRelationship } from 'gitnexus-shared';
import type { KnowledgeGraph } from '../core/graph/types';

// Re-export shared pipeline types
export type { PipelinePhase, PipelineProgress } from 'gitnexus-shared';

// Web-specific: in-memory result after hydration
export interface PipelineResult {
  graph: KnowledgeGraph;
  fileContents: Map<string, string>;
}

// Web-specific: serializable format for Web Worker communication
export interface SerializablePipelineResult {
  nodes: GraphNode[];
  relationships: GraphRelationship[];
  fileContents: Record<string, string>;
}
