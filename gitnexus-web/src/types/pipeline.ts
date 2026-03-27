import type { GraphNode, GraphRelationship } from 'gitnexus-shared';

// Re-export shared pipeline types
export type { PipelinePhase, PipelineProgress } from 'gitnexus-shared';

// Web-specific: serializable format for Web Worker communication
export interface SerializablePipelineResult {
  nodes: GraphNode[];
  relationships: GraphRelationship[];
  fileContents: Record<string, string>;
}
