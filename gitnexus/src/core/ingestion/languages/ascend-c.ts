/**
 * Ascend C Language Provider
 *
 * Huawei's C++ dialect for programming Ascend NPU kernels.
 * Reuses tree-sitter-cpp for parsing (via sourcePreprocessor that strips
 * non-standard attributes) with Ascend C-specific built-in names and
 * import semantics identical to C++.
 */

import { SupportedLanguages } from 'gitnexus-shared';
import { createClassExtractor } from '../class-extractors/generic.js';
import { ascendCClassConfig } from '../class-extractors/configs/ascend-c.js';
import { defineLanguage } from '../language-provider.js';
import { typeConfig as cCppConfig } from '../type-extractors/c-cpp.js';
import { cCppExportChecker } from '../export-detection.js';
import { createImportResolver } from '../import-resolvers/resolver-factory.js';
import { ascendCImportConfig } from '../import-resolvers/configs/ascend-c.js';
import { CPP_QUERIES } from '../tree-sitter-queries.js';
import { createFieldExtractor } from '../field-extractors/generic.js';
import { cppConfig as cppFieldConfig } from '../field-extractors/configs/c-cpp.js';
import { createMethodExtractor } from '../method-extractors/generic.js';
import { cppMethodConfig } from '../method-extractors/configs/c-cpp.js';
import { createVariableExtractor } from '../variable-extractors/generic.js';
import { cppVariableConfig } from '../variable-extractors/configs/c-cpp.js';
import { createCallExtractor } from '../call-extractors/generic.js';
import { ascendCCallConfig } from '../call-extractors/configs/ascend-c.js';
import { createHeritageExtractor } from '../heritage-extractors/generic.js';
import { preprocessAscendC } from '../ascend-c-preprocessor.js';
import type { SyntaxNode } from '../utils/ast-helpers.js';
import type { NodeLabel } from 'gitnexus-shared';
import type { LanguageProvider } from '../language-provider.js';

/**
 * C/C++ function name extraction — shared with c-cpp.ts.
 * Unwraps pointer_declarator / reference_declarator chains to find the actual name.
 */
const FUNCTION_DECLARATION_TYPES = new Set([
  'function_declaration',
  'function_definition',
  'async_function_declaration',
  'generator_function_declaration',
  'function_item',
]);

const ascendCExtractFunctionName = (
  node: SyntaxNode,
): { funcName: string | null; label: NodeLabel } | null => {
  if (!FUNCTION_DECLARATION_TYPES.has(node.type)) return null;

  let funcName: string | null = null;
  let label: NodeLabel = 'Function';

  let declarator = node.childForFieldName?.('declarator');
  if (!declarator) {
    for (let i = 0; i < node.childCount; i++) {
      const c = node.child(i);
      if (c?.type === 'function_declarator') {
        declarator = c;
        break;
      }
    }
  }
  while (
    declarator &&
    (declarator.type === 'pointer_declarator' || declarator.type === 'reference_declarator')
  ) {
    let nextDeclarator = declarator.childForFieldName?.('declarator');
    if (!nextDeclarator) {
      for (let i = 0; i < declarator.childCount; i++) {
        const c = declarator.child(i);
        if (
          c?.type === 'function_declarator' ||
          c?.type === 'pointer_declarator' ||
          c?.type === 'reference_declarator'
        ) {
          nextDeclarator = c;
          break;
        }
      }
    }
    declarator = nextDeclarator;
  }
  if (declarator) {
    let innerDeclarator = declarator.childForFieldName?.('declarator');
    if (!innerDeclarator) {
      for (let i = 0; i < declarator.childCount; i++) {
        const c = declarator.child(i);
        if (
          c?.type === 'qualified_identifier' ||
          c?.type === 'identifier' ||
          c?.type === 'field_identifier' ||
          c?.type === 'parenthesized_declarator'
        ) {
          innerDeclarator = c;
          break;
        }
      }
    }

    if (innerDeclarator?.type === 'qualified_identifier') {
      let nameNode = innerDeclarator.childForFieldName?.('name');
      if (!nameNode) {
        for (let i = 0; i < innerDeclarator.childCount; i++) {
          const c = innerDeclarator.child(i);
          if (c?.type === 'identifier') {
            nameNode = c;
            break;
          }
        }
      }
      if (nameNode?.text) {
        funcName = nameNode.text;
        label = 'Method';
      }
    } else if (
      innerDeclarator?.type === 'identifier' ||
      innerDeclarator?.type === 'field_identifier'
    ) {
      funcName = innerDeclarator.text;
      if (innerDeclarator.type === 'field_identifier') label = 'Method';
    } else if (innerDeclarator?.type === 'parenthesized_declarator') {
      let nestedId: SyntaxNode | null = null;
      for (let i = 0; i < innerDeclarator.childCount; i++) {
        const c = innerDeclarator.child(i);
        if (c?.type === 'qualified_identifier' || c?.type === 'identifier') {
          nestedId = c;
          break;
        }
      }
      if (nestedId?.type === 'qualified_identifier') {
        let nameNode = nestedId.childForFieldName?.('name');
        if (!nameNode) {
          for (let i = 0; i < nestedId.childCount; i++) {
            const c = nestedId.child(i);
            if (c?.type === 'identifier') {
              nameNode = c;
              break;
            }
          }
        }
        if (nameNode?.text) {
          funcName = nameNode.text;
          label = 'Method';
        }
      } else if (nestedId?.type === 'identifier') {
        funcName = nestedId.text;
      }
    }
  }

  if (!funcName) {
    let nameNode = node.childForFieldName?.('name');
    if (!nameNode) {
      for (let i = 0; i < node.childCount; i++) {
        const c = node.child(i);
        if (
          c?.type === 'identifier' ||
          c?.type === 'property_identifier' ||
          c?.type === 'simple_identifier'
        ) {
          nameNode = c;
          break;
        }
      }
    }
    funcName = nameNode?.text ?? null;
  }

  return { funcName, label };
};

function isInsideClassOrStruct(functionNode: SyntaxNode): boolean {
  let ancestor: SyntaxNode | null = functionNode?.parent ?? null;
  while (ancestor) {
    if (ancestor.type === 'class_specifier' || ancestor.type === 'struct_specifier') return true;
    ancestor = ancestor.parent;
  }
  return false;
}

const ascendCLabelOverride: NonNullable<LanguageProvider['labelOverride']> = (
  functionNode,
  defaultLabel,
) => {
  if (defaultLabel !== 'Function') return defaultLabel;
  return isInsideClassOrStruct(functionNode) ? null : defaultLabel;
};

/**
 * Ascend C SDK built-in names — well-known types and functions from the
 * Ascend C runtime/SDK that are not defined in user code. Marking them as
 * built-ins prevents spurious "unresolved call" noise in the knowledge graph.
 */
const ASCEND_C_BUILT_INS: ReadonlySet<string> = new Set([
  // ── C standard library (inherited) ──
  'printf',
  'fprintf',
  'sprintf',
  'snprintf',
  'malloc',
  'calloc',
  'realloc',
  'free',
  'memcpy',
  'memmove',
  'memset',
  'memcmp',
  'strlen',
  'strcpy',
  'strncpy',
  'strcmp',
  'strncmp',
  'sizeof',
  'assert',

  // ── Data movement ──
  'DataCopy',
  'DataCopyExtParams',
  'DataCopyPad',
  'DataCopyPadExtParams',
  'EnQue',
  'DeQue',
  'FreeTensor',
  'AllocTensor',

  // ── Compute — vector/scalar ──
  'Add',
  'Sub',
  'Mul',
  'Div',
  'Abs',
  'Exp',
  'Log',
  'Reciprocal',
  'Sqrt',
  'Rsqrt',
  'Relu',
  'Sigmoid',
  'Tanh',
  'Max',
  'Min',
  'Cast',
  'Select',
  'Compare',
  'Gather',
  'Scatter',
  'Concat',
  'ReduceSum',
  'ReduceMax',
  'ReduceMin',
  'Matmul',
  'Conv2D',
  'Softmax',
  'TopK',
  'Sort',
  'ArgMax',
  'ArgMin',
  'Transpose',
  'Pad',
  'Slice',
  'Muls',
  'Adds',
  'Maxs',
  'Mins',
  'Duplicate',
  'Ceil',
  'Floor',
  'Round',
  'Neg',
  'Not',
  'And',
  'Or',

  // ── Atomic operations ──
  'SetAtomicAdd',
  'SetAtomicMax',
  'SetAtomicMin',
  'SetAtomicNone',
  'SetAtomicType',

  // ── Tensor types (used as template instantiations) ──
  'GlobalTensor',
  'LocalTensor',
  'TPipe',
  'TBuf',
  'TQue',

  // ── Buffer / queue management ──
  'InitBuffer',
  'InitGlobalBuffer',
  'GetTensorData',
  'SetTensorData',
  'GetSize',
  'GetLength',
  'SetSize',

  // ── Synchronisation ──
  'PipeBarrier',
  'SetFlag',
  'WaitFlag',
  'SyncAll',

  // ── Runtime helpers ──
  'GetBlockNum',
  'GetBlockIdx',
  'AscendC',

  // ── Pipe type constants (enum-like, appear as identifiers) ──
  'PIPE_MTE1',
  'PIPE_MTE2',
  'PIPE_MTE3',
  'PIPE_V',
  'PIPE_M',
  'PIPE_S',
  'PIPE_A',
  'PIPE_B',
  'PIPE_CU',
]);

export const ascendCProvider = defineLanguage({
  id: SupportedLanguages.AscendC,
  extensions: ['.asc'],
  treeSitterQueries: CPP_QUERIES,
  typeConfig: cCppConfig,
  exportChecker: cCppExportChecker,
  importResolver: createImportResolver(ascendCImportConfig),
  importSemantics: 'wildcard-transitive' as const,
  mroStrategy: 'leftmost-base' as const,
  callExtractor: createCallExtractor(ascendCCallConfig),
  fieldExtractor: createFieldExtractor(cppFieldConfig),
  methodExtractor: createMethodExtractor({
    ...cppMethodConfig,
    extractFunctionName: ascendCExtractFunctionName,
  }),
  variableExtractor: createVariableExtractor(cppVariableConfig),
  classExtractor: createClassExtractor(ascendCClassConfig),
  heritageExtractor: createHeritageExtractor(SupportedLanguages.AscendC),
  labelOverride: ascendCLabelOverride,
  builtInNames: ASCEND_C_BUILT_INS,
  preprocessSource: preprocessAscendC,
});
