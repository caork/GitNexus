/**
 * Language Detection — maps file paths to SupportedLanguages enum values.
 *
 * Shared between CLI (ingestion pipeline) and web (syntax highlighting).
 */

import { SupportedLanguages } from './languages.js';

/** Ruby extensionless filenames recognised as Ruby source */
const RUBY_EXTENSIONLESS_FILES = new Set(['Rakefile', 'Gemfile', 'Guardfile', 'Vagrantfile', 'Brewfile']);

/**
 * Map file extension to SupportedLanguage enum.
 * Returns null if the file extension is not recognized.
 */
export const getLanguageFromFilename = (filename: string): SupportedLanguages | null => {
  // TypeScript (including TSX)
  if (filename.endsWith('.tsx')) return SupportedLanguages.TypeScript;
  if (filename.endsWith('.ts')) return SupportedLanguages.TypeScript;
  // JavaScript (including JSX)
  if (filename.endsWith('.jsx')) return SupportedLanguages.JavaScript;
  if (filename.endsWith('.js')) return SupportedLanguages.JavaScript;
  // Python
  if (filename.endsWith('.py')) return SupportedLanguages.Python;
  // Java
  if (filename.endsWith('.java')) return SupportedLanguages.Java;
  // C source files
  if (filename.endsWith('.c')) return SupportedLanguages.C;
  // C++ (all common extensions, including .h)
  // .h is parsed as C++ because tree-sitter-cpp is a strict superset of C, so pure-C
  // headers parse correctly, and C++ headers (classes, templates) are handled properly.
  if (filename.endsWith('.cpp') || filename.endsWith('.cc') || filename.endsWith('.cxx') ||
      filename.endsWith('.h') || filename.endsWith('.hpp') || filename.endsWith('.hxx') || filename.endsWith('.hh')) return SupportedLanguages.CPlusPlus;
  // C#
  if (filename.endsWith('.cs')) return SupportedLanguages.CSharp;
  // Go
  if (filename.endsWith('.go')) return SupportedLanguages.Go;
  // Rust
  if (filename.endsWith('.rs')) return SupportedLanguages.Rust;
  // Kotlin
  if (filename.endsWith('.kt') || filename.endsWith('.kts')) return SupportedLanguages.Kotlin;
  // PHP (all common extensions)
  if (filename.endsWith('.php') || filename.endsWith('.phtml') ||
      filename.endsWith('.php3') || filename.endsWith('.php4') ||
      filename.endsWith('.php5') || filename.endsWith('.php8')) {
    return SupportedLanguages.PHP;
  }
  // Ruby (extensions)
  if (filename.endsWith('.rb') || filename.endsWith('.rake') || filename.endsWith('.gemspec')) {
    return SupportedLanguages.Ruby;
  }
  // Ruby (extensionless files)
  const basename = filename.split('/').pop() || filename;
  if (RUBY_EXTENSIONLESS_FILES.has(basename)) {
    return SupportedLanguages.Ruby;
  }
  // Swift
  if (filename.endsWith('.swift')) return SupportedLanguages.Swift;
  // Dart
  if (filename.endsWith('.dart')) return SupportedLanguages.Dart;
  // COBOL
  if (filename.endsWith('.cbl') || filename.endsWith('.cob') ||
      filename.endsWith('.cpy') || filename.endsWith('.cobol')) {
    return SupportedLanguages.Cobol;
  }
  return null;
};

/** Non-code file extensions → Prism-compatible syntax identifiers */
const AUXILIARY_SYNTAX_MAP: Record<string, string> = {
  json: 'json', yaml: 'yaml', yml: 'yaml',
  md: 'markdown', mdx: 'markdown',
  html: 'markup', htm: 'markup', erb: 'markup', xml: 'markup',
  css: 'css', scss: 'css', sass: 'css',
  sh: 'bash', bash: 'bash', zsh: 'bash',
  sql: 'sql', toml: 'toml', ini: 'ini',
  dockerfile: 'docker',
};

/** Extensionless filenames → Prism-compatible syntax identifiers */
const AUXILIARY_BASENAME_MAP: Record<string, string> = {
  Makefile: 'makefile', Dockerfile: 'docker',
};

/**
 * Map file path to a Prism-compatible syntax highlight language string.
 * Covers all SupportedLanguages (code files) plus common non-code formats.
 * Returns 'text' for unrecognised files.
 */
export const getSyntaxLanguageFromFilename = (filePath: string): string => {
  const lang = getLanguageFromFilename(filePath);
  if (lang) return lang;
  const ext = filePath.split('.').pop()?.toLowerCase();
  if (ext && ext in AUXILIARY_SYNTAX_MAP) return AUXILIARY_SYNTAX_MAP[ext];
  const basename = filePath.split('/').pop() || '';
  if (basename in AUXILIARY_BASENAME_MAP) return AUXILIARY_BASENAME_MAP[basename];
  return 'text';
};
