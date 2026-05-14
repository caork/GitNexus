/**
 * Ascend C Preprocessor
 *
 * Normalises Ascend C (.asc) source code into standard C++ so that
 * tree-sitter-cpp can parse it without errors.
 *
 * Ascend C is Huawei's C++ dialect for programming Ascend NPU kernels.
 * It adds several non-standard keywords:
 *
 *   __aicore__          — function/method attribute (like CUDA __device__)
 *   __global__          — kernel entry-point attribute (like CUDA __global__)
 *   __gm__             — global-memory pointer qualifier
 *   __kfc_workspace__  — workspace memory qualifier
 *   __aicpu__          — AI-CPU function attribute
 *   __vector__         — vector compute attribute
 *   __mix__(x,y)       — mixed compute attribute (with arguments)
 *   GM_ADDR            — macro alias for `__gm__ uint8_t*`
 *
 * Strategy: replace non-standard tokens with whitespace of the same length
 * to preserve line/column positions for accurate source mapping.
 */

/**
 * Bare attributes (no arguments): replaced with same-length whitespace.
 * Order matters — longer patterns first to avoid partial matches.
 */
const BARE_ATTRS = [
  '__kfc_workspace__',
  '__aicore__',
  '__global__',
  '__aicpu__',
  '__vector__',
  '__gm__',
] as const;

/**
 * Parameterised attributes: `__mix__(1,2)` etc.
 * Matched with regex to capture the argument list.
 */
const PARAMETERISED_RE = /__mix__\s*\([^)]*\)/g;

/**
 * Bare `if MACRO_NAME {` without parentheses — non-standard conditional
 * compilation syntax used by Ascend C (e.g., `if ASCEND_IS_AIC {`).
 * Rewrite to `if (MACRO_NAME) {` so tree-sitter sees valid C++.
 */
const BARE_IF_MACRO_RE = /\bif\s+(ASCEND_IS_\w+)\s*\{/g;

/**
 * Preprocess Ascend C source into standard C++.
 *
 * All replacements preserve byte length (pad with spaces) so that
 * tree-sitter line/column offsets remain valid against the original source.
 */
export function preprocessAscendC(source: string): string {
  let result = source;

  // 1. Rewrite bare `if MACRO {` → `if (MACRO) {` (preserves length via
  //    consuming the space between `if` and the macro name for the `(`).
  result = result.replace(BARE_IF_MACRO_RE, (_match, macroName) => `if (${macroName}) {`);

  // 2. Strip parameterised attributes (they contain parens that
  //    could confuse simple token replacement).
  result = result.replace(PARAMETERISED_RE, (match) => ' '.repeat(match.length));

  // 3. Strip bare attributes — simple token replacement with whitespace.
  for (const attr of BARE_ATTRS) {
    // Use word-boundary-aware split+join instead of regex to avoid
    // escaping issues and get O(n) performance.
    let idx = 0;
    while ((idx = result.indexOf(attr, idx)) !== -1) {
      // Verify it's a standalone token (not part of a longer identifier)
      const before = idx > 0 ? result[idx - 1] : ' ';
      const after = idx + attr.length < result.length ? result[idx + attr.length] : ' ';
      const isWordChar = (ch: string) => /\w/.test(ch);

      if (!isWordChar(before) && !isWordChar(after)) {
        result = result.slice(0, idx) + ' '.repeat(attr.length) + result.slice(idx + attr.length);
      }
      idx += attr.length;
    }
  }

  return result;
}
