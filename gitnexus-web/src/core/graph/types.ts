/**
 * Re-export shared graph types from gitnexus-shared.
 *
 * Web-specific additions (KnowledgeGraph interface) are defined here.
 * Core types (NodeLabel, GraphNode, etc.) come from the shared package.
 */
export type {
  NodeLabel,
  NodeProperties,
  RelationshipType,
  GraphNode,
  GraphRelationship,
} from 'gitnexus-shared';

// Web-specific: in-memory graph container (not shared — CLI version has more methods)
export interface KnowledgeGraph {
  nodes: import('gitnexus-shared').GraphNode[];
  relationships: import('gitnexus-shared').GraphRelationship[];
  nodeCount: number;
  relationshipCount: number;
  addNode: (node: import('gitnexus-shared').GraphNode) => void;
  addRelationship: (relationship: import('gitnexus-shared').GraphRelationship) => void;
}
