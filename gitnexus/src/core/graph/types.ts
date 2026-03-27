/**
 * Re-export shared graph types from gitnexus-shared.
 *
 * CLI-specific additions: KnowledgeGraph interface with mutation methods.
 * Core types (NodeLabel, GraphNode, etc.) come from the shared package.
 */
export type {
  NodeLabel,
  NodeProperties,
  RelationshipType,
  GraphNode,
  GraphRelationship,
} from 'gitnexus-shared';

import type { GraphNode, GraphRelationship } from 'gitnexus-shared';

// CLI-specific: full KnowledgeGraph with mutation methods for incremental updates
export interface KnowledgeGraph {
  /** Returns a full array copy — prefer iterNodes() for iteration */
  nodes: GraphNode[];
  /** Returns a full array copy — prefer iterRelationships() for iteration */
  relationships: GraphRelationship[];
  /** Zero-copy iterator over nodes */
  iterNodes: () => IterableIterator<GraphNode>;
  /** Zero-copy iterator over relationships */
  iterRelationships: () => IterableIterator<GraphRelationship>;
  /** Zero-copy forEach — avoids iterator protocol overhead in hot loops */
  forEachNode: (fn: (node: GraphNode) => void) => void;
  forEachRelationship: (fn: (rel: GraphRelationship) => void) => void;
  /** Lookup a single node by id — O(1) */
  getNode: (id: string) => GraphNode | undefined;
  nodeCount: number;
  relationshipCount: number;
  addNode: (node: GraphNode) => void;
  addRelationship: (relationship: GraphRelationship) => void;
  removeNode: (nodeId: string) => boolean;
  removeNodesByFile: (filePath: string) => number;
  removeRelationship: (relationshipId: string) => boolean;
}
