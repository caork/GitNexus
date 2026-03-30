/**
 * Ontology Schema Types
 *
 * Palantir-inspired ontology meta-model for GitNexus.
 * Defines the schema layer that sits above the knowledge graph,
 * providing typed Object Types, Link Types, Interfaces, and
 * Shared Properties with cardinality constraints.
 *
 * This is a schema-only layer — it describes the shape of the graph,
 * not the graph data itself. The physical storage (LadybugDB) is unchanged.
 */

// ─── Property Base Types ────────────────────────────────────────────

export type PropertyBaseType =
  | 'String'
  | 'Integer'
  | 'Double'
  | 'Boolean'
  | 'Timestamp'
  | 'StringArray';

// ─── Shared Property ────────────────────────────────────────────────

export interface SharedPropertyDef {
  /** Unique identifier for the shared property */
  id: string;
  /** Programmatic name (used in API responses) */
  apiName: string;
  /** Human-readable display name */
  displayName: string;
  /** Description of the property's meaning */
  description?: string;
  /** Data type */
  baseType: PropertyBaseType;
}

// ─── Property Definition ────────────────────────────────────────────

export interface PropertyDef {
  /** Programmatic name (must be unique within the Object Type) */
  apiName: string;
  /** Human-readable display name */
  displayName: string;
  /** Description */
  description?: string;
  /** Data type */
  baseType: PropertyBaseType;
  /** Whether this property must have a value */
  required: boolean;
  /** Reference to a shared property (if this is a usage of one) */
  sharedPropertyId?: string;
}

// ─── Interface (Polymorphic Abstract Type) ──────────────────────────

export interface OntologyInterface {
  /** Unique identifier */
  apiName: string;
  /** Human-readable display name */
  displayName: string;
  /** Description of what this interface represents */
  description?: string;
  /** Properties that implementors must have */
  properties: PropertyDef[];
  /** Parent interfaces this interface extends */
  extends?: string[];
}

// ─── Object Type ────────────────────────────────────────────────────

export type ObjectTypeStatus = 'active' | 'experimental' | 'deprecated';

export interface ObjectTypeDef {
  /** Programmatic name (maps to GitNexus NodeLabel) */
  apiName: string;
  /** Human-readable display name */
  displayName: string;
  /** Description of what this object type represents */
  description?: string;
  /** Primary key property name */
  primaryKey: string;
  /** All properties (including those from interfaces) */
  properties: PropertyDef[];
  /** Interfaces this Object Type implements */
  interfaces: string[];
  /** Lifecycle status */
  status: ObjectTypeStatus;
  /** The original GitNexus NodeLabel(s) that map to this type */
  sourceLabels: string[];
}

// ─── Link Type ──────────────────────────────────────────────────────

export type LinkCardinality = 'one-to-one' | 'one-to-many' | 'many-to-one' | 'many-to-many';

export interface LinkTypeDef {
  /** Programmatic name (maps to GitNexus RelationshipType) */
  apiName: string;
  /** Human-readable display name */
  displayName: string;
  /** Description of the relationship */
  description?: string;
  /** Source Object Type or Interface */
  sourceType: string;
  /** Target Object Type or Interface */
  targetType: string;
  /** Cardinality constraint */
  cardinality: LinkCardinality;
  /** Properties on the link itself */
  properties: PropertyDef[];
  /** Lifecycle status */
  status: ObjectTypeStatus;
  /** The original GitNexus RelationshipType that maps to this */
  sourceRelType: string;
}

// ─── Ontology Schema (top-level container) ──────────────────────────

export interface OntologySchema {
  /** Schema version for compatibility */
  version: string;
  /** Human-readable name */
  name: string;
  /** Description */
  description?: string;
  /** Shared property definitions */
  sharedProperties: SharedPropertyDef[];
  /** Interface definitions */
  interfaces: OntologyInterface[];
  /** Object type definitions */
  objectTypes: ObjectTypeDef[];
  /** Link type definitions */
  linkTypes: LinkTypeDef[];
}
