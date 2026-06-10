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
import { ascendCMethodConfig } from '../method-extractors/configs/ascend-c.js';
import { createVariableExtractor } from '../variable-extractors/generic.js';
import { cppVariableConfig } from '../variable-extractors/configs/c-cpp.js';
import { createCallExtractor } from '../call-extractors/generic.js';
import { ascendCCallConfig } from '../call-extractors/configs/ascend-c.js';
import { preprocessAscendC, getAscendCAttributesForCurrentFile } from '../ascend-c-preprocessor.js';
import {
  emitCppScopeCaptures,
  interpretCppImport,
  interpretCppTypeBinding,
  cppArityCompatibility,
  cppBindingScopeFor,
  cppImportOwningScope,
  cppReceiverBinding,
  collectCppCaptureSideChannel,
} from './cpp/index.js';
import { getDefinitionNodeFromCaptures } from '../utils/ast-helpers.js';
import type { SyntaxNode } from '../utils/ast-helpers.js';
import type { NodeLabel } from 'gitnexus-shared';
import type { LanguageProvider, CaptureMap } from '../language-provider.js';

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

  // ── C++ standard library ──
  'std',
  'make_shared',
  'make_unique',
  'move',
  'forward',
  'static_cast',
  'dynamic_cast',
  'reinterpret_cast',
  'const_cast',

  // ── Data movement ──
  'DataCopy',
  'DataCopyExtParams',
  'DataCopyPad',
  'DataCopyPadExtParams',
  'DataCopyB2S',
  'DataCopyS2B',
  'DataCopyB2B',
  'DataCopyDepadB2B',
  'DataCopyND2NZ',
  'DataCopyNZ2ND',
  'LoadData',
  'LoadData2D',
  'LoadData2dParams',
  'LoadDataWithFlag',
  'StoreData',
  'EnQue',
  'DeQue',
  'FreeTensor',
  'AllocTensor',

  // ── Compute — vector/scalar/cube ──
  'Add',
  'Sub',
  'Mul',
  'Div',
  'Abs',
  'Exp',
  'Log',
  'Ln',
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
  'ReduceMean',
  'Matmul',
  'MatmulObj',
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
  'BitwiseAnd',
  'BitwiseOr',
  'BitwiseNot',
  'ShiftLeft',
  'ShiftRight',
  'Clamp',
  'LeakyRelu',
  'PRelu',
  'Gelu',
  'Erf',
  'Power',
  'Mod',
  'Atan',
  'Atan2',
  'Sin',
  'Cos',
  'Asin',
  'Acos',
  'Sinh',
  'Cosh',
  'Sign',
  'IsFinite',
  'IsNan',
  'ConvertTo',

  // ── Scalar operations ──
  'ScalarAdd',
  'ScalarSub',
  'ScalarMul',
  'ScalarDiv',
  'ScalarMax',
  'ScalarMin',
  'ScalarAbs',

  // ── Vector advanced ──
  'WholeReduceSum',
  'WholeReduceMax',
  'WholeReduceMin',
  'VectorDup',
  'PadCustom',
  'RepeatMode',
  'BinaryRepeatParams',
  'UnaryRepeatParams',

  // ── Cube (matrix) compute ──
  'Mmad',
  'MmadObj',
  'Fixpipe',
  'FixpipeObj',
  'SetFixpipeNz2Nd',

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
  'GetValue',
  'SetValue',
  'GetPhyAddr',
  'ReinterpretCast',

  // ── Tiling (kernel launch parameters) ──
  'TilingData',
  'GET_TILING_DATA',
  'TilingContext',
  'AscendCPlatform',
  'GetUserWorkspace',

  // ── Synchronisation ──
  'PipeBarrier',
  'SetFlag',
  'WaitFlag',
  'SyncAll',
  'CrossCoreSync',
  'WaitBarrier',
  'SetBarrier',

  // ── Runtime helpers ──
  'GetBlockNum',
  'GetBlockIdx',
  'GetTaskRation',
  'GetSysWorkSpacePtr',
  'AscendC',

  // ── Data type qualifiers ──
  'half',
  'float16_t',
  'bfloat16_t',
  'int4b_t',
  'uint4b_t',
  'int8_t',
  'uint8_t',
  'int16_t',
  'uint16_t',
  'int32_t',
  'uint32_t',
  'int64_t',
  'uint64_t',

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
  'PIPE_ALL',

  // ── Buffer position constants ──
  'VECIN',
  'VECOUT',
  'VECCALC',
  'A1',
  'A2',
  'B1',
  'B2',
  'CO1',
  'CO2',

  // ── KernelOperator base class (extended by user kernel classes) ──
  'KernelOperator',
  'KfcKernelBase',
]);

// ============================================================================
// Description extractor — Ascend C domain semantics
// ============================================================================

/**
 * Produce human-readable descriptions for Ascend C code elements.
 *
 * These descriptions appear in query/context results and give the agent
 * immediate domain knowledge:
 *
 *   - `__global__` method/function → "Kernel entry point"
 *   - `__aicore__` method/function → "Device compute function (AI Core)"
 *   - `__aicpu__` method/function  → "Host-side AI CPU function"
 *   - `__vector__` method/function → "Vector compute function"
 *   - Class containing `__aicore__` methods → "Kernel operator class"
 *   - Class extending a kernel base → "Kernel operator class"
 */
const ascendCDescriptionExtractor = (
  nodeLabel: NodeLabel,
  nodeName: string,
  captureMap: CaptureMap,
): string | undefined => {
  // Get the definition node to find its line range
  const defNode = getDefinitionNodeFromCaptures(captureMap);
  if (!defNode) return undefined;

  const startLine = defNode.startPosition.row + 1;
  const endLine = defNode.endPosition.row + 1;
  const attrs = getAscendCAttributesForCurrentFile(startLine, endLine);

  if (nodeLabel === 'Function' || nodeLabel === 'Method') {
    // Prioritise __global__ (kernel entry) over __aicore__ (device compute)
    if (attrs.includes('__global__')) {
      return 'Kernel entry point (host-callable)';
    }
    if (attrs.includes('__aicore__')) {
      return 'Device compute function (AI Core)';
    }
    if (attrs.includes('__aicpu__')) {
      return 'Host-side AI CPU function';
    }
    if (attrs.includes('__vector__')) {
      return 'Vector compute function';
    }
    // Well-known kernel lifecycle methods
    if (nodeName === 'Init' || nodeName === 'Process') {
      // These are likely kernel methods even without attributes — check parent
      const parent = defNode.parent;
      if (
        parent?.type === 'field_declaration_list' &&
        (parent.parent?.type === 'class_specifier' || parent.parent?.type === 'struct_specifier')
      ) {
        if (nodeName === 'Init') return 'Kernel initialisation method';
        if (nodeName === 'Process') return 'Kernel compute entry (per-core)';
      }
    }
  }

  if (nodeLabel === 'Class' || nodeLabel === 'Struct') {
    // Check if this class/struct has any __aicore__ or __global__ methods
    // by scanning its body's line range in the attribute cache
    if (attrs.includes('__aicore__') || attrs.includes('__global__')) {
      return 'Kernel operator class';
    }
    // Check heritage: classes extending known kernel base types
    if (defNode.text) {
      const snippet = defNode.text.slice(0, 500); // First 500 chars
      if (
        snippet.includes('KernelOperator') ||
        snippet.includes('KfcKernelBase') ||
        snippet.includes('OpDef')
      ) {
        return 'Kernel operator class';
      }
    }
  }

  return undefined;
};

export const ascendCProvider = defineLanguage({
  id: SupportedLanguages.AscendC,
  extensions: ['.asc'],
  treeSitterQueries: CPP_QUERIES,
  typeConfig: cCppConfig,
  exportChecker: cCppExportChecker,
  importResolver: createImportResolver(ascendCImportConfig),
  mroStrategy: 'leftmost-base' as const,
  callExtractor: createCallExtractor(ascendCCallConfig),
  fieldExtractor: createFieldExtractor(cppFieldConfig),
  methodExtractor: createMethodExtractor({
    ...ascendCMethodConfig,
    extractFunctionName: ascendCExtractFunctionName,
  }),
  variableExtractor: createVariableExtractor(cppVariableConfig),
  classExtractor: createClassExtractor(ascendCClassConfig),
  labelOverride: ascendCLabelOverride,
  builtInNames: ASCEND_C_BUILT_INS,
  preprocessSource: preprocessAscendC,
  descriptionExtractor: ascendCDescriptionExtractor,

  // Scope-based resolution hooks — reuse C++'s wholesale: after
  // `preprocessAscendC` strips the NPU attribute keywords the AST is plain
  // tree-sitter-cpp, so C++ capture emission / receiver binding / member
  // lookup apply unchanged.
  emitScopeCaptures: emitCppScopeCaptures,
  collectCaptureSideChannel: collectCppCaptureSideChannel,
  interpretImport: interpretCppImport,
  interpretTypeBinding: interpretCppTypeBinding,
  bindingScopeFor: cppBindingScopeFor,
  importOwningScope: cppImportOwningScope,
  receiverBinding: cppReceiverBinding,
  arityCompatibility: cppArityCompatibility,
});
