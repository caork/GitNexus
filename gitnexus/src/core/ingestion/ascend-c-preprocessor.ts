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
 *
 * ## Dual-channel extraction
 *
 * The preprocessor operates in two passes on the original source:
 *
 * 1. **Attribute extraction** — scans for `__global__`, `__aicore__`, etc.
 *    and records which attributes appear near which line numbers. The result
 *    is cached per file path so downstream extractors (method, class) can
 *    annotate nodes with domain-specific semantics.
 *
 * 2. **Stripping** — replaces all non-standard tokens with whitespace so
 *    tree-sitter-cpp sees valid C++.
 *
 * Both passes are length-preserving (the stripping pass) or read-only
 * (the extraction pass), so tree-sitter line/column offsets stay valid.
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

// ============================================================================
// Attribute extraction — dual-channel pass 1
// ============================================================================

/**
 * Recognised Ascend C function/method attributes and their semantic labels.
 * Keys are the raw tokens as they appear in source; values are the normalised
 * annotation strings stored in the knowledge graph.
 */
const SEMANTIC_ATTRS: ReadonlyMap<string, string> = new Map([
  ['__global__', '__global__'],
  ['__aicore__', '__aicore__'],
  ['__aicpu__', '__aicpu__'],
  ['__vector__', '__vector__'],
]);

/** Regex that matches any semantic attribute token on a line. */
const SEMANTIC_ATTR_RE = /\b(__global__|__aicore__|__aicpu__|__vector__)\b/g;

/**
 * Per-file cache of extracted attributes.
 *
 * Key: file path. Value: map of 1-based line number → list of attribute strings.
 *
 * The cache is populated by `preprocessAscendC()` on the **original** source
 * before stripping, and consumed by the method/class extractors via
 * `getAscendCAttributes()`. Since both preprocessing and extraction happen
 * in the same thread in the same file-processing loop, the cache is always
 * fresh when the extractor reads it.
 *
 * The cache is bounded: only the most recent file is kept (each call to
 * `preprocessAscendC` replaces the previous entry) to avoid memory bloat
 * in large repos with thousands of `.asc` files.
 */
let _cachedFilePath: string | null = null;
let _cachedAttributes: Map<number, string[]> = new Map();

/**
 * Extract Ascend C semantic attributes from the **original** (un-stripped) source.
 *
 * Returns a map of 1-based line numbers to the list of Ascend C attributes
 * found on that line. Only lines containing at least one recognised attribute
 * are included.
 *
 * This is the "read" channel of the dual-channel preprocessor: it extracts
 * metadata without modifying the source.
 */
export function extractAscendCAttributes(source: string): Map<number, string[]> {
  const attrs = new Map<number, string[]>();
  const lines = source.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineAttrs: string[] = [];
    let m: RegExpExecArray | null;
    SEMANTIC_ATTR_RE.lastIndex = 0;
    while ((m = SEMANTIC_ATTR_RE.exec(line)) !== null) {
      const label = SEMANTIC_ATTRS.get(m[1]);
      if (label && !lineAttrs.includes(label)) lineAttrs.push(label);
    }
    if (lineAttrs.length > 0) {
      attrs.set(i + 1, lineAttrs); // 1-based line numbers
    }
  }
  return attrs;
}

/**
 * Query the attribute cache for a specific file and line range.
 *
 * Returns all unique attributes found between `startLine` and `endLine`
 * (inclusive, 1-based). Returns an empty array if the file is not cached
 * or no attributes exist in the range.
 *
 * The "search window" extends a few lines above `startLine` to catch
 * attributes placed on the line immediately preceding a function/method
 * definition (the common pattern in Ascend C: `__global__ __aicore__ void Init(...)`
 * may have the attribute on the same line or a preceding line).
 */
export function getAscendCAttributes(
  filePath: string,
  startLine: number,
  endLine?: number,
): string[] {
  if (filePath !== _cachedFilePath) return [];

  const result: string[] = [];
  // Search window: 3 lines above startLine to endLine (or startLine + 5)
  const from = Math.max(1, startLine - 3);
  const to = endLine ?? startLine + 5;
  for (let line = from; line <= to; line++) {
    const lineAttrs = _cachedAttributes.get(line);
    if (lineAttrs) {
      for (const a of lineAttrs) {
        if (!result.includes(a)) result.push(a);
      }
    }
  }
  return result;
}

/**
 * Query attributes for the currently-cached file (no file-path argument).
 *
 * This is used by `extractAnnotations` in the method extractor, which only
 * receives the AST node and has no access to the file path. Since
 * preprocessing and extraction happen sequentially per-file in the same
 * thread, the cache always holds the correct file's attributes.
 */
export function getAscendCAttributesForCurrentFile(startLine: number, endLine?: number): string[] {
  if (!_cachedFilePath) return [];
  return getAscendCAttributes(_cachedFilePath, startLine, endLine);
}

/**
 * Clear the attribute cache. Called between files or at the end of analysis.
 */
export function clearAscendCAttributeCache(): void {
  _cachedFilePath = null;
  _cachedAttributes = new Map();
}

// ============================================================================
// Source stripping — dual-channel pass 2
// ============================================================================

/**
 * Preprocess Ascend C source into standard C++.
 *
 * This function performs both channels of the dual-channel preprocessor:
 * 1. Extracts attribute metadata from the original source (cached for
 *    downstream extractors via `getAscendCAttributes()`)
 * 2. Strips non-standard tokens into whitespace so tree-sitter-cpp can parse
 *
 * All replacements preserve byte length (pad with spaces) so that
 * tree-sitter line/column offsets remain valid against the original source.
 *
 * @param source  — original Ascend C source text
 * @param filePath — path used as cache key for attribute queries
 */
export function preprocessAscendC(source: string, filePath?: string): string {
  // Pass 1: extract attribute metadata from the original source
  _cachedAttributes = extractAscendCAttributes(source);
  _cachedFilePath = filePath ?? null;

  // Pass 2: strip non-standard tokens
  let result = source;

  // 2a. Rewrite bare `if MACRO {` → `if (MACRO) {` (preserves length via
  //     consuming the space between `if` and the macro name for the `(`).
  result = result.replace(BARE_IF_MACRO_RE, (_match, macroName) => `if (${macroName}) {`);

  // 2b. Strip parameterised attributes (they contain parens that
  //     could confuse simple token replacement).
  result = result.replace(PARAMETERISED_RE, (match) => ' '.repeat(match.length));

  // 2c. Strip bare attributes — simple token replacement with whitespace.
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
