---
title: "Field Extractors for All Supported Languages"
type: feat
status: active
date: 2026-03-26
---

# Field Extractors for All Supported Languages

## Overview

PR #494 adds a `FieldExtractor` infrastructure with only a TypeScript implementation. This plan fills the registry for all 14 supported languages using a table-driven generic extractor, plus unit tests.

## Approach: Generic Table-Driven Extractor

Instead of 14 separate 300+ line files, create a `GenericFieldExtractor` configured via a per-language `FieldExtractionConfig`. Each config specifies:
- AST node types for type declarations (class_declaration, struct_item, etc.)
- AST node types for field declarations within bodies
- How to extract field name, type, visibility, static, readonly from the AST
- Default visibility and body node type

## Implementation

### Phase 1: Generic Field Extractor

**Create:** `field-extractors/generic.ts`

A single `createFieldExtractor(config)` factory that returns a `FieldExtractor` for any language.

### Phase 2: Language Configs

**Create:** `field-extractors/configs.ts`

Export configs for all 14 languages. Each config is ~20-40 lines of node type mappings.

### Phase 3: Register All in Index

**Modify:** `field-extractors/index.ts`

Register all 14 extractors. Keep the TypeScript-specific class for backwards compatibility.

### Phase 4: Unit Tests

**Create:** `test/unit/field-extraction-all-languages.test.ts`

For each language, parse a small code snippet and verify the extractor produces correct FieldInfo[].

## Acceptance Criteria

- [x] GenericFieldExtractor created with table-driven config
- [ ] Configs for: TS, JS, Python, Java, Kotlin, Go, Rust, C#, C++, C, PHP, Ruby, Swift, Dart
- [ ] All extractors registered in index.ts
- [ ] Unit tests for all languages
- [ ] `npx tsc --noEmit` passes
- [ ] All tests pass
