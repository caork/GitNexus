/**
 * Default Ontology Schema
 *
 * Maps the existing GitNexus graph model (35 NodeLabels, 21 RelationshipTypes)
 * to a Palantir-style Ontology with Interfaces, Shared Properties, and
 * cardinality constraints.
 *
 * This is the built-in schema used when no custom schema is configured.
 */

import type { OntologySchema, SharedPropertyDef, OntologyInterface, ObjectTypeDef, LinkTypeDef, PropertyDef } from './ontology-schema.js';

// ─── Shared Properties ──────────────────────────────────────────────

const SHARED_PROPERTIES: SharedPropertyDef[] = [
  { id: 'sp_name', apiName: 'name', displayName: 'Name', baseType: 'String', description: 'Human-readable name of the entity' },
  { id: 'sp_filePath', apiName: 'filePath', displayName: 'File Path', baseType: 'String', description: 'Absolute path to the source file' },
  { id: 'sp_startLine', apiName: 'startLine', displayName: 'Start Line', baseType: 'Integer', description: 'Starting line number in source file' },
  { id: 'sp_endLine', apiName: 'endLine', displayName: 'End Line', baseType: 'Integer', description: 'Ending line number in source file' },
  { id: 'sp_isExported', apiName: 'isExported', displayName: 'Is Exported', baseType: 'Boolean', description: 'Whether the symbol is exported/public' },
  { id: 'sp_content', apiName: 'content', displayName: 'Content', baseType: 'String', description: 'Source code content' },
  { id: 'sp_description', apiName: 'description', displayName: 'Description', baseType: 'String', description: 'Human-readable description' },
  { id: 'sp_heuristicLabel', apiName: 'heuristicLabel', displayName: 'Label', baseType: 'String', description: 'Auto-detected or LLM-generated label' },
  { id: 'sp_confidence', apiName: 'confidence', displayName: 'Confidence', baseType: 'Double', description: 'Resolution confidence score (0-1)' },
  { id: 'sp_reason', apiName: 'reason', displayName: 'Reason', baseType: 'String', description: 'Semantic reason for the relationship' },
];

// ─── Helpers ────────────────────────────────────────────────────────

const prop = (apiName: string, displayName: string, baseType: PropertyDef['baseType'], required = false, sharedPropertyId?: string, description?: string): PropertyDef => ({
  apiName, displayName, baseType, required, sharedPropertyId, description,
});

// Common property sets (reused via interfaces)
const CODE_ENTITY_PROPS: PropertyDef[] = [
  prop('id', 'ID', 'String', true, undefined, 'Unique node identifier'),
  prop('name', 'Name', 'String', true, 'sp_name'),
  prop('filePath', 'File Path', 'String', true, 'sp_filePath'),
  prop('startLine', 'Start Line', 'Integer', false, 'sp_startLine'),
  prop('endLine', 'End Line', 'Integer', false, 'sp_endLine'),
  prop('isExported', 'Is Exported', 'Boolean', false, 'sp_isExported'),
  prop('content', 'Content', 'String', false, 'sp_content'),
  prop('description', 'Description', 'String', false, 'sp_description'),
];

const CALLABLE_PROPS: PropertyDef[] = [
  prop('parameterCount', 'Parameter Count', 'Integer', false, undefined, 'Number of parameters'),
  prop('returnType', 'Return Type', 'String', false, undefined, 'Declared return type'),
];

const TYPE_DEF_PROPS: PropertyDef[] = [
  prop('declaredType', 'Declared Type', 'String', false, undefined, 'Type annotation'),
  prop('visibility', 'Visibility', 'String', false, undefined, 'public/private/protected'),
  prop('isStatic', 'Is Static', 'Boolean', false),
];

// ─── Interfaces ─────────────────────────────────────────────────────

const INTERFACES: OntologyInterface[] = [
  {
    apiName: 'CodeEntity',
    displayName: 'Code Entity',
    description: 'Base interface for all source code elements with file location',
    properties: CODE_ENTITY_PROPS,
  },
  {
    apiName: 'Callable',
    displayName: 'Callable',
    description: 'Invocable code element (function, method, constructor)',
    properties: CALLABLE_PROPS,
    extends: ['CodeEntity'],
  },
  {
    apiName: 'TypeDefinition',
    displayName: 'Type Definition',
    description: 'Named type (class, interface, struct, enum, trait)',
    properties: TYPE_DEF_PROPS,
    extends: ['CodeEntity'],
  },
  {
    apiName: 'FileSystemEntry',
    displayName: 'File System Entry',
    description: 'File or directory in the repository',
    properties: [
      prop('id', 'ID', 'String', true),
      prop('name', 'Name', 'String', true, 'sp_name'),
      prop('filePath', 'File Path', 'String', true, 'sp_filePath'),
    ],
  },
  {
    apiName: 'ArchitecturalUnit',
    displayName: 'Architectural Unit',
    description: 'High-level structural grouping (community, process)',
    properties: [
      prop('id', 'ID', 'String', true),
      prop('heuristicLabel', 'Label', 'String', false, 'sp_heuristicLabel'),
      prop('description', 'Description', 'String', false, 'sp_description'),
    ],
  },
];

// ─── Object Types ───────────────────────────────────────────────────

const OBJECT_TYPES: ObjectTypeDef[] = [
  // ── Callable implementations ──
  {
    apiName: 'Function', displayName: 'Function',
    description: 'Standalone function or arrow function',
    primaryKey: 'id', interfaces: ['Callable'],
    properties: [...CODE_ENTITY_PROPS, ...CALLABLE_PROPS],
    status: 'active', sourceLabels: ['Function'],
  },
  {
    apiName: 'Method', displayName: 'Method',
    description: 'Method defined on a class, struct, or trait',
    primaryKey: 'id', interfaces: ['Callable'],
    properties: [...CODE_ENTITY_PROPS, ...CALLABLE_PROPS],
    status: 'active', sourceLabels: ['Method'],
  },
  {
    apiName: 'Constructor', displayName: 'Constructor',
    description: 'Class or struct constructor',
    primaryKey: 'id', interfaces: ['Callable'],
    properties: [...CODE_ENTITY_PROPS, ...CALLABLE_PROPS],
    status: 'active', sourceLabels: ['Constructor'],
  },

  // ── TypeDefinition implementations ──
  {
    apiName: 'Class', displayName: 'Class',
    description: 'Class definition',
    primaryKey: 'id', interfaces: ['TypeDefinition'],
    properties: [...CODE_ENTITY_PROPS, ...TYPE_DEF_PROPS],
    status: 'active', sourceLabels: ['Class'],
  },
  {
    apiName: 'Interface', displayName: 'Interface',
    description: 'Interface or protocol definition',
    primaryKey: 'id', interfaces: ['TypeDefinition'],
    properties: [...CODE_ENTITY_PROPS, ...TYPE_DEF_PROPS],
    status: 'active', sourceLabels: ['Interface'],
  },
  {
    apiName: 'Struct', displayName: 'Struct',
    description: 'Struct or data class',
    primaryKey: 'id', interfaces: ['TypeDefinition'],
    properties: [...CODE_ENTITY_PROPS, ...TYPE_DEF_PROPS],
    status: 'active', sourceLabels: ['Struct'],
  },
  {
    apiName: 'Enum', displayName: 'Enum',
    description: 'Enumeration type',
    primaryKey: 'id', interfaces: ['TypeDefinition'],
    properties: [...CODE_ENTITY_PROPS, ...TYPE_DEF_PROPS],
    status: 'active', sourceLabels: ['Enum'],
  },
  {
    apiName: 'Trait', displayName: 'Trait',
    description: 'Trait (Rust) or mixin',
    primaryKey: 'id', interfaces: ['TypeDefinition'],
    properties: [...CODE_ENTITY_PROPS, ...TYPE_DEF_PROPS],
    status: 'active', sourceLabels: ['Trait'],
  },
  {
    apiName: 'TypeAlias', displayName: 'Type Alias',
    description: 'Type alias or typedef',
    primaryKey: 'id', interfaces: ['TypeDefinition'],
    properties: [...CODE_ENTITY_PROPS, ...TYPE_DEF_PROPS],
    status: 'active', sourceLabels: ['TypeAlias', 'Typedef'],
  },
  {
    apiName: 'Record', displayName: 'Record',
    description: 'Record type (Java, C#)',
    primaryKey: 'id', interfaces: ['TypeDefinition'],
    properties: [...CODE_ENTITY_PROPS, ...TYPE_DEF_PROPS],
    status: 'active', sourceLabels: ['Record'],
  },

  // ── FileSystemEntry implementations ──
  {
    apiName: 'File', displayName: 'File',
    description: 'Source code file',
    primaryKey: 'id', interfaces: ['FileSystemEntry'],
    properties: [
      prop('id', 'ID', 'String', true),
      prop('name', 'Name', 'String', true, 'sp_name'),
      prop('filePath', 'File Path', 'String', true, 'sp_filePath'),
      prop('content', 'Content', 'String', false, 'sp_content'),
      prop('description', 'Description', 'String', false, 'sp_description'),
    ],
    status: 'active', sourceLabels: ['File'],
  },
  {
    apiName: 'Folder', displayName: 'Folder',
    description: 'Directory in the repository',
    primaryKey: 'id', interfaces: ['FileSystemEntry'],
    properties: [
      prop('id', 'ID', 'String', true),
      prop('name', 'Name', 'String', true, 'sp_name'),
      prop('filePath', 'File Path', 'String', true, 'sp_filePath'),
    ],
    status: 'active', sourceLabels: ['Folder'],
  },

  // ── ArchitecturalUnit implementations ──
  {
    apiName: 'Community', displayName: 'Functional Area',
    description: 'Auto-detected code community via Leiden clustering',
    primaryKey: 'id', interfaces: ['ArchitecturalUnit'],
    properties: [
      prop('id', 'ID', 'String', true),
      prop('heuristicLabel', 'Label', 'String', false, 'sp_heuristicLabel'),
      prop('description', 'Description', 'String', false, 'sp_description'),
      prop('cohesion', 'Cohesion', 'Double', false, undefined, 'Internal cohesion score (0-1)'),
      prop('symbolCount', 'Symbol Count', 'Integer', false, undefined, 'Number of member symbols'),
      prop('keywords', 'Keywords', 'StringArray', false, undefined, 'Auto-detected keywords'),
      prop('enrichedBy', 'Enriched By', 'String', false, undefined, 'heuristic or llm'),
    ],
    status: 'active', sourceLabels: ['Community'],
  },
  {
    apiName: 'Process', displayName: 'Execution Flow',
    description: 'Traced execution flow from entry point through call chain',
    primaryKey: 'id', interfaces: ['ArchitecturalUnit'],
    properties: [
      prop('id', 'ID', 'String', true),
      prop('heuristicLabel', 'Label', 'String', false, 'sp_heuristicLabel'),
      prop('description', 'Description', 'String', false, 'sp_description'),
      prop('processType', 'Process Type', 'String', false, undefined, 'intra_community or cross_community'),
      prop('stepCount', 'Step Count', 'Integer', false, undefined, 'Number of steps in trace'),
      prop('communities', 'Communities', 'StringArray', false, undefined, 'Community IDs touched'),
      prop('entryPointId', 'Entry Point', 'String', false, undefined, 'ID of the entry point symbol'),
      prop('terminalId', 'Terminal', 'String', false, undefined, 'ID of the terminal symbol'),
    ],
    status: 'active', sourceLabels: ['Process'],
  },

  // ── Other code elements ──
  {
    apiName: 'Property', displayName: 'Property',
    description: 'Field or property on a class/struct',
    primaryKey: 'id', interfaces: ['CodeEntity'],
    properties: [
      ...CODE_ENTITY_PROPS,
      prop('declaredType', 'Declared Type', 'String', false, undefined, 'Type annotation'),
      prop('visibility', 'Visibility', 'String', false),
      prop('isStatic', 'Is Static', 'Boolean', false),
      prop('isReadonly', 'Is Readonly', 'Boolean', false),
    ],
    status: 'active', sourceLabels: ['Property'],
  },
  {
    apiName: 'Const', displayName: 'Constant',
    description: 'Constant or static value',
    primaryKey: 'id', interfaces: ['CodeEntity'],
    properties: CODE_ENTITY_PROPS,
    status: 'active', sourceLabels: ['Const', 'Static'],
  },
  {
    apiName: 'Namespace', displayName: 'Namespace',
    description: 'Namespace or module scope',
    primaryKey: 'id', interfaces: ['CodeEntity'],
    properties: CODE_ENTITY_PROPS,
    status: 'active', sourceLabels: ['Namespace', 'Module', 'Package'],
  },
  {
    apiName: 'Impl', displayName: 'Implementation Block',
    description: 'Rust impl block',
    primaryKey: 'id', interfaces: ['CodeEntity'],
    properties: CODE_ENTITY_PROPS,
    status: 'active', sourceLabels: ['Impl'],
  },
  {
    apiName: 'Macro', displayName: 'Macro',
    description: 'Macro definition',
    primaryKey: 'id', interfaces: ['Callable'],
    properties: [...CODE_ENTITY_PROPS, ...CALLABLE_PROPS],
    status: 'active', sourceLabels: ['Macro'],
  },
  {
    apiName: 'Delegate', displayName: 'Delegate',
    description: 'Delegate type (C#)',
    primaryKey: 'id', interfaces: ['Callable'],
    properties: [...CODE_ENTITY_PROPS, ...CALLABLE_PROPS],
    status: 'active', sourceLabels: ['Delegate'],
  },
  {
    apiName: 'Route', displayName: 'HTTP Endpoint',
    description: 'HTTP route handler (REST API endpoint)',
    primaryKey: 'id', interfaces: ['Callable'],
    properties: [
      ...CODE_ENTITY_PROPS,
      prop('responseKeys', 'Response Keys', 'StringArray', false, undefined, 'Keys in response JSON'),
      prop('errorKeys', 'Error Keys', 'StringArray', false, undefined, 'Keys in error response'),
      prop('middleware', 'Middleware', 'StringArray', false, undefined, 'Middleware chain'),
    ],
    status: 'active', sourceLabels: ['Route'],
  },
  {
    apiName: 'Tool', displayName: 'Tool',
    description: 'MCP/RPC tool definition',
    primaryKey: 'id', interfaces: ['CodeEntity'],
    properties: CODE_ENTITY_PROPS,
    status: 'active', sourceLabels: ['Tool'],
  },
  {
    apiName: 'Section', displayName: 'Document Section',
    description: 'Markdown heading section',
    primaryKey: 'id', interfaces: [],
    properties: [
      prop('id', 'ID', 'String', true),
      prop('name', 'Name', 'String', true, 'sp_name'),
      prop('filePath', 'File Path', 'String', true, 'sp_filePath'),
      prop('startLine', 'Start Line', 'Integer', false, 'sp_startLine'),
      prop('endLine', 'End Line', 'Integer', false, 'sp_endLine'),
      prop('level', 'Heading Level', 'Integer', false, undefined, 'Heading level 1-6'),
      prop('content', 'Content', 'String', false, 'sp_content'),
    ],
    status: 'active', sourceLabels: ['Section'],
  },
  {
    apiName: 'CodeElement', displayName: 'Code Element',
    description: 'Catch-all for code elements not covered by specific types',
    primaryKey: 'id', interfaces: ['CodeEntity'],
    properties: CODE_ENTITY_PROPS,
    status: 'active', sourceLabels: ['CodeElement', 'Variable', 'Decorator', 'Import', 'Type', 'Union', 'Annotation', 'Template'],
  },
];

// ─── Link Types ─────────────────────────────────────────────────────

const LINK_CONFIDENCE_PROP = prop('confidence', 'Confidence', 'Double', false, 'sp_confidence', 'Resolution confidence (0-1)');
const LINK_REASON_PROP = prop('reason', 'Reason', 'String', false, 'sp_reason', 'Semantic reason');
const STANDARD_LINK_PROPS: PropertyDef[] = [LINK_CONFIDENCE_PROP, LINK_REASON_PROP];

const LINK_TYPES: LinkTypeDef[] = [
  // ── Invocation ──
  {
    apiName: 'CALLS', displayName: 'Calls',
    description: 'Function/method invocation',
    sourceType: 'Callable', targetType: 'Callable',
    cardinality: 'many-to-many',
    properties: STANDARD_LINK_PROPS,
    status: 'active', sourceRelType: 'CALLS',
  },
  {
    apiName: 'FETCHES', displayName: 'Fetches',
    description: 'HTTP fetch/request call',
    sourceType: 'Callable', targetType: 'Route',
    cardinality: 'many-to-many',
    properties: STANDARD_LINK_PROPS,
    status: 'active', sourceRelType: 'FETCHES',
  },

  // ── Inheritance & Implementation ──
  {
    apiName: 'EXTENDS', displayName: 'Extends',
    description: 'Class inheritance (is-a)',
    sourceType: 'TypeDefinition', targetType: 'TypeDefinition',
    cardinality: 'many-to-one',
    properties: STANDARD_LINK_PROPS,
    status: 'active', sourceRelType: 'EXTENDS',
  },
  {
    apiName: 'IMPLEMENTS', displayName: 'Implements',
    description: 'Interface/trait implementation',
    sourceType: 'TypeDefinition', targetType: 'TypeDefinition',
    cardinality: 'many-to-many',
    properties: STANDARD_LINK_PROPS,
    status: 'active', sourceRelType: 'IMPLEMENTS',
  },
  {
    apiName: 'OVERRIDES', displayName: 'Overrides',
    description: 'Method override via MRO',
    sourceType: 'Method', targetType: 'Method',
    cardinality: 'many-to-one',
    properties: STANDARD_LINK_PROPS,
    status: 'active', sourceRelType: 'OVERRIDES',
  },

  // ── Containment & Ownership ──
  {
    apiName: 'CONTAINS', displayName: 'Contains',
    description: 'Folder/file containment hierarchy',
    sourceType: 'FileSystemEntry', targetType: 'FileSystemEntry',
    cardinality: 'one-to-many',
    properties: STANDARD_LINK_PROPS,
    status: 'active', sourceRelType: 'CONTAINS',
  },
  {
    apiName: 'DEFINES', displayName: 'Defines',
    description: 'File defines a symbol',
    sourceType: 'File', targetType: 'CodeEntity',
    cardinality: 'one-to-many',
    properties: STANDARD_LINK_PROPS,
    status: 'active', sourceRelType: 'DEFINES',
  },
  {
    apiName: 'HAS_METHOD', displayName: 'Has Method',
    description: 'Type owns a method',
    sourceType: 'TypeDefinition', targetType: 'Callable',
    cardinality: 'one-to-many',
    properties: STANDARD_LINK_PROPS,
    status: 'active', sourceRelType: 'HAS_METHOD',
  },
  {
    apiName: 'HAS_PROPERTY', displayName: 'Has Property',
    description: 'Type owns a field/property',
    sourceType: 'TypeDefinition', targetType: 'Property',
    cardinality: 'one-to-many',
    properties: STANDARD_LINK_PROPS,
    status: 'active', sourceRelType: 'HAS_PROPERTY',
  },

  // ── Dependencies ──
  {
    apiName: 'IMPORTS', displayName: 'Imports',
    description: 'Module import dependency',
    sourceType: 'File', targetType: 'File',
    cardinality: 'many-to-many',
    properties: STANDARD_LINK_PROPS,
    status: 'active', sourceRelType: 'IMPORTS',
  },
  {
    apiName: 'USES', displayName: 'Uses',
    description: 'Symbol usage reference',
    sourceType: 'CodeEntity', targetType: 'CodeEntity',
    cardinality: 'many-to-many',
    properties: STANDARD_LINK_PROPS,
    status: 'active', sourceRelType: 'USES',
  },
  {
    apiName: 'ACCESSES', displayName: 'Accesses',
    description: 'Field read or write access (reason: read/write)',
    sourceType: 'Callable', targetType: 'Property',
    cardinality: 'many-to-many',
    properties: STANDARD_LINK_PROPS,
    status: 'active', sourceRelType: 'ACCESSES',
  },
  {
    apiName: 'DECORATES', displayName: 'Decorates',
    description: 'Decorator/annotation applied to a symbol',
    sourceType: 'CodeEntity', targetType: 'CodeEntity',
    cardinality: 'many-to-many',
    properties: STANDARD_LINK_PROPS,
    status: 'active', sourceRelType: 'DECORATES',
  },

  // ── Architectural ──
  {
    apiName: 'MEMBER_OF', displayName: 'Member Of',
    description: 'Symbol belongs to a functional area (community)',
    sourceType: 'CodeEntity', targetType: 'Community',
    cardinality: 'many-to-one',
    properties: STANDARD_LINK_PROPS,
    status: 'active', sourceRelType: 'MEMBER_OF',
  },
  {
    apiName: 'STEP_IN_PROCESS', displayName: 'Step In Process',
    description: 'Symbol participates as step N in an execution flow',
    sourceType: 'CodeEntity', targetType: 'Process',
    cardinality: 'many-to-many',
    properties: [
      ...STANDARD_LINK_PROPS,
      prop('step', 'Step Number', 'Integer', false, undefined, '1-indexed step position in trace'),
    ],
    status: 'active', sourceRelType: 'STEP_IN_PROCESS',
  },
  {
    apiName: 'ENTRY_POINT_OF', displayName: 'Entry Point Of',
    description: 'Symbol is the entry point of a process/route/tool',
    sourceType: 'CodeEntity', targetType: 'ArchitecturalUnit',
    cardinality: 'many-to-one',
    properties: STANDARD_LINK_PROPS,
    status: 'active', sourceRelType: 'ENTRY_POINT_OF',
  },

  // ── Web / API ──
  {
    apiName: 'HANDLES_ROUTE', displayName: 'Handles Route',
    description: 'Function handles an HTTP route',
    sourceType: 'Callable', targetType: 'Route',
    cardinality: 'many-to-one',
    properties: STANDARD_LINK_PROPS,
    status: 'active', sourceRelType: 'HANDLES_ROUTE',
  },
  {
    apiName: 'HANDLES_TOOL', displayName: 'Handles Tool',
    description: 'Function handles an MCP/RPC tool',
    sourceType: 'Callable', targetType: 'Tool',
    cardinality: 'many-to-one',
    properties: STANDARD_LINK_PROPS,
    status: 'active', sourceRelType: 'HANDLES_TOOL',
  },
  {
    apiName: 'WRAPS', displayName: 'Wraps',
    description: 'Middleware wrapping relationship',
    sourceType: 'Callable', targetType: 'Callable',
    cardinality: 'many-to-many',
    properties: STANDARD_LINK_PROPS,
    status: 'active', sourceRelType: 'WRAPS',
  },
  {
    apiName: 'QUERIES', displayName: 'Queries',
    description: 'ORM/database query relationship',
    sourceType: 'Callable', targetType: 'CodeEntity',
    cardinality: 'many-to-many',
    properties: STANDARD_LINK_PROPS,
    status: 'active', sourceRelType: 'QUERIES',
  },
];

// ─── Default Ontology Schema ────────────────────────────────────────

export const DEFAULT_ONTOLOGY: OntologySchema = {
  version: '1.0.0',
  name: 'GitNexus Code Ontology',
  description: 'Palantir-aligned ontology for source code knowledge graphs. Maps code entities, relationships, and architectural structures to typed Object Types with Interface polymorphism.',
  sharedProperties: SHARED_PROPERTIES,
  interfaces: INTERFACES,
  objectTypes: OBJECT_TYPES,
  linkTypes: LINK_TYPES,
};
