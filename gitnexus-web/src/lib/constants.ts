import type { NodeLabel } from 'gitnexus-shared';

// Node colors by type - Celestial Bodies Space Theme
export const NODE_COLORS: Record<NodeLabel, string> = {
  Project: '#D022FA', // Nebula Purple
  Package: '#00E1FF', // Blue Supergiant (Cyan)
  Module: '#00E1FF', // Blue Supergiant (Cyan)
  Folder: '#00E1FF', // Blue Supergiant (Cyan)
  File: '#6BB8E3', // Gas Giant (Ice Blue)
  Class: '#FDB813', // Sun / Main Sequence Star (Gold)
  Function: '#FF5E4D', // Red Dwarf / Solar Flare (Red)
  Method: '#FF5E4D', // Red Dwarf / Solar Flare (Red)
  Variable: '#9B9B9B', // Asteroid (Gray)
  Interface: '#FDB813', // Sun / Main Sequence Star (Gold)
  Enum: '#A6B0D5', // White Dwarf (Pale Blue)
  Decorator: '#A6B0D5', // White Dwarf (Pale Blue)
  Import: '#555566', // Deep Space Rock (Dark Gray)
  Type: '#FDB813', // Sun / Main Sequence Star (Gold)
  CodeElement: '#9B9B9B', // Asteroid (Gray)
  Community: '#D022FA', // Nebula Purple
  Process: '#D022FA', // Nebula Purple
  Section: '#00E1FF', // Blue Supergiant (Cyan)
  Struct: '#FDB813', // Sun / Main Sequence Star (Gold)
  Trait: '#FDB813', // Sun / Main Sequence Star (Gold)
  Impl: '#FF5E4D', // Red Dwarf / Solar Flare (Red)
  TypeAlias: '#FDB813', // Sun / Main Sequence Star (Gold)
  Const: '#9B9B9B', // Asteroid (Gray)
  Static: '#9B9B9B', // Asteroid (Gray)
  Namespace: '#00E1FF', // Blue Supergiant (Cyan)
  Union: '#FDB813', // Sun / Main Sequence Star (Gold)
  Typedef: '#FDB813', // Sun / Main Sequence Star (Gold)
  Macro: '#FF5E4D', // Red Dwarf / Solar Flare (Red)
  Property: '#9B9B9B', // Asteroid (Gray)
  Record: '#FDB813', // Sun / Main Sequence Star (Gold)
  Delegate: '#FF5E4D', // Red Dwarf / Solar Flare (Red)
  Annotation: '#A6B0D5', // White Dwarf (Pale Blue)
  Constructor: '#FF5E4D', // Red Dwarf / Solar Flare (Red)
  Template: '#FDB813', // Sun / Main Sequence Star (Gold)
  Route: '#D022FA', // Nebula Purple
  Tool: '#D022FA', // Nebula Purple
};

// Node sizes by type - clear visual hierarchy with dramatic size differences
// Structural nodes are MUCH larger to make hierarchy obvious
export const NODE_SIZES: Record<NodeLabel, number> = {
  Project: 20, // Largest - root of everything
  Package: 16, // Major structural element
  Module: 13, // Important container
  Folder: 10, // Structural - clearly bigger than files
  File: 6, // Common element - smaller than folders
  Class: 8, // Important code structure
  Function: 4, // Common code element - small
  Method: 3, // Smaller than function
  Variable: 2, // Tiny - leaf node
  Interface: 7, // Important type definition
  Enum: 5, // Type definition
  Decorator: 2, // Tiny modifier
  Import: 1.5, // Very small - usually hidden anyway
  Type: 3, // Type alias - small
  CodeElement: 2, // Generic small
  Community: 0, // Hidden by default - metadata node
  Process: 0, // Hidden by default - metadata node
  Section: 8, // Structural section - similar to Folder
  Struct: 8, // Like Class
  Trait: 7, // Like Interface
  Impl: 3, // Like Method
  TypeAlias: 3, // Like Type
  Const: 2, // Like Variable
  Static: 2, // Like Variable
  Namespace: 13, // Like Module
  Union: 5, // Like Enum
  Typedef: 3, // Like Type
  Macro: 2, // Like Decorator
  Property: 2, // Like Variable
  Record: 8, // Like Class
  Delegate: 3, // Like Method
  Annotation: 2, // Like Decorator
  Constructor: 4, // Like Function
  Template: 3, // Like Type
  Route: 5, // Like Enum
  Tool: 5, // Like Enum
};

// ─── Ontology Interface Color Palette ────────────────────────────────────
// Astronomical Theme: Unified identity via space metaphors
export const INTERFACE_COLORS: Record<string, string> = {
  Callable: '#FF5E4D', // Red Dwarf / Flare Red — functions, methods, constructors, macros
  TypeDefinition: '#FDB813', // Sun Gold — classes, interfaces, structs, enums, traits
  FileSystemEntry: '#6BB8E3', // Gas Giant Ice Blue — files, folders
  ArchitecturalUnit: '#00E1FF', // Blue Supergiant Cyan — communities, processes
  CodeEntity: '#A6B0D5', // White Dwarf Pale Blue — generic code elements (fallback)
};

// Community color palette for cluster-based coloring
export const COMMUNITY_COLORS = [
  '#ef4444', // red
  '#f97316', // orange
  '#eab308', // yellow
  '#22c55e', // green
  '#06b6d4', // cyan
  '#3b82f6', // blue
  '#8b5cf6', // violet
  '#d946ef', // fuchsia
  '#ec4899', // pink
  '#f43f5e', // rose
  '#14b8a6', // teal
  '#84cc16', // lime
];

export const getCommunityColor = (communityIndex: number): string => {
  return COMMUNITY_COLORS[communityIndex % COMMUNITY_COLORS.length];
};

// Labels to show by default (hide imports and variables by default as they clutter)
export const DEFAULT_VISIBLE_LABELS: NodeLabel[] = [
  'Project',
  'Package',
  'Module',
  'Folder',
  'File',
  'Class',
  'Function',
  'Method',
  'Interface',
  'Enum',
  'Type',
];

// All filterable labels (in display order)
export const FILTERABLE_LABELS: NodeLabel[] = [
  'Folder',
  'File',
  'Class',
  'Interface',
  'Enum',
  'Type',
  'Function',
  'Method',
  'Variable',
  'Decorator',
  'Import',
];

// Edge/Relation types
export type EdgeType = 'CONTAINS' | 'DEFINES' | 'IMPORTS' | 'CALLS' | 'EXTENDS' | 'IMPLEMENTS';

export const ALL_EDGE_TYPES: EdgeType[] = [
  'CONTAINS',
  'DEFINES',
  'IMPORTS',
  'CALLS',
  'EXTENDS',
  'IMPLEMENTS',
];

// Default visible edges (CALLS hidden by default to reduce clutter)
export const DEFAULT_VISIBLE_EDGES: EdgeType[] = [
  'CONTAINS',
  'DEFINES',
  'IMPORTS',
  'EXTENDS',
  'IMPLEMENTS',
  'CALLS',
];

// Edge display info for UI
export const EDGE_INFO: Record<EdgeType, { color: string; label: string }> = {
  CONTAINS: { color: '#2d5a3d', label: 'Contains' },
  DEFINES: { color: '#0e7490', label: 'Defines' },
  IMPORTS: { color: '#1d4ed8', label: 'Imports' },
  CALLS: { color: '#7c3aed', label: 'Calls' },
  EXTENDS: { color: '#c2410c', label: 'Extends' },
  IMPLEMENTS: { color: '#be185d', label: 'Implements' },
};
