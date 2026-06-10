import { SupportedLanguages } from 'gitnexus-shared';
import type { ImportResolutionConfig } from '../types.js';
import { createStandardStrategy } from '../standard.js';

export const ascendCImportConfig: ImportResolutionConfig = {
  language: SupportedLanguages.AscendC,
  strategies: [createStandardStrategy(SupportedLanguages.AscendC)],
};
