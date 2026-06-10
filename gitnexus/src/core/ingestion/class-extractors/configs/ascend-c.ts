import { SupportedLanguages } from 'gitnexus-shared';
import type { ClassExtractionConfig } from '../../class-types.js';

export const ascendCClassConfig: ClassExtractionConfig = {
  language: SupportedLanguages.AscendC,
  typeDeclarationNodes: ['class_specifier', 'struct_specifier', 'enum_specifier'],
  ancestorScopeNodeTypes: ['namespace_definition', 'class_specifier', 'struct_specifier'],
};
