import { SupportedLanguages, getLanguageFromFilename, type ParsedFile } from 'gitnexus-shared';
import type { ScopeResolver } from '../../scope-resolution/contract/scope-resolver.js';
import { extractParsedFile } from '../../scope-extractor-bridge.js';
import { cppScopeResolver } from '../cpp/scope-resolver.js';
import { ascendCProvider } from '../ascend-c.js';

/** Languages whose files an `.asc` translation unit may `#include`. */
const isAscendCScopeContextLanguage = (lang: SupportedLanguages | null): boolean =>
  lang === SupportedLanguages.CPlusPlus || lang === SupportedLanguages.C;

/**
 * Ascend C `ScopeResolver` — C++'s resolver re-keyed for the `.asc` dialect.
 *
 * After `preprocessAscendC` strips the NPU attribute keywords the AST is
 * plain tree-sitter-cpp, so every C++ scope rule (namespaces, classes,
 * overload arity, leftmost-base MRO, `#include` header augmentation)
 * applies unchanged.
 *
 * `collectScopeContextPaths` mirrors Vue's closure expansion: `.asc` kernels
 * `#include` C/C++ headers, but those headers are bucketed under the C++
 * pass — without pulling the include closure into THIS pass, receiver-bound
 * member calls (`op.Init(...)` on a class defined in a header) can never
 * resolve because the registry lacks the member definitions.
 */
export const ascendCScopeResolver: ScopeResolver = {
  ...cppScopeResolver,
  language: SupportedLanguages.AscendC,
  languageProvider: ascendCProvider,
  importEdgeReason: 'ascend-c-scope: include',

  collectScopeContextPaths({
    primaryFilePaths,
    preExtractedByPath,
    entryFileContents,
    allScannedPaths,
    resolutionConfig,
  }) {
    const resolveTargets = (targetRaw: string, fromFile: string): readonly string[] => {
      const resolved = ascendCScopeResolver.resolveImportTarget(
        targetRaw,
        fromFile,
        allScannedPaths,
        resolutionConfig,
      );
      if (resolved === null) return [];
      if (typeof resolved === 'string') return [resolved];
      return resolved;
    };

    const visited = new Set<string>(primaryFilePaths);
    const queue = [...primaryFilePaths];
    const fallbackParsed = new Map<string, ParsedFile>();

    while (queue.length > 0) {
      const current = queue.shift();
      if (current === undefined) break;
      let parsed = preExtractedByPath.get(current) ?? fallbackParsed.get(current) ?? undefined;
      if (parsed === undefined) {
        const source = entryFileContents.get(current);
        if (source !== undefined) {
          parsed = extractParsedFile(ascendCProvider, source, current);
          if (parsed !== undefined) fallbackParsed.set(current, parsed);
        }
      }
      if (parsed === undefined) continue;

      for (const parsedImport of parsed.parsedImports) {
        if (parsedImport.targetRaw.trim().length === 0) continue;
        for (const targetPath of resolveTargets(parsedImport.targetRaw, current)) {
          if (!allScannedPaths.has(targetPath)) continue;
          const targetLang = getLanguageFromFilename(targetPath);
          if (
            targetLang !== SupportedLanguages.AscendC &&
            !isAscendCScopeContextLanguage(targetLang)
          ) {
            continue;
          }
          if (visited.has(targetPath)) continue;
          visited.add(targetPath);
          queue.push(targetPath);
        }
      }
    }

    return visited;
  },
};
