// gitnexus/src/core/ingestion/field-extractors/configs/ruby.ts

import { SupportedLanguages } from '../../../../config/supported-languages.js';
import type { FieldExtractionConfig } from '../generic.js';

/**
 * Ruby field extraction config.
 *
 * Ruby is unusual: there are no field declarations in the traditional sense.
 * Fields are instance variables (@var) created by assignment, or declared
 * via attr_accessor / attr_reader / attr_writer calls.
 *
 * We detect:
 * - `call` nodes for attr_accessor / attr_reader / attr_writer
 *   (their arguments are symbol names → field names)
 *
 * For simplicity we focus on attr_* calls in the class body.
 * Instance variable assignments (self.x = ...) would require deeper analysis.
 */
export const rubyConfig: FieldExtractionConfig = {
  language: SupportedLanguages.Ruby,
  typeDeclarationNodes: ['class'],
  fieldNodeTypes: ['call'],
  bodyNodeTypes: ['body_statement'],
  defaultVisibility: 'public',

  extractName(node) {
    // call node: method = attr_accessor / attr_reader / attr_writer
    const method = node.childForFieldName('method');
    if (!method) return undefined;
    const methodName = method.text;
    if (methodName !== 'attr_accessor' && methodName !== 'attr_reader'
      && methodName !== 'attr_writer') {
      return undefined;
    }
    // arguments: argument_list > simple_symbol (:name)
    const args = node.childForFieldName('arguments');
    if (!args) return undefined;
    const firstArg = args.firstNamedChild;
    if (!firstArg) return undefined;
    // simple_symbol text is :name — strip the colon
    const text = firstArg.text;
    return text.startsWith(':') ? text.slice(1) : text;
  },

  extractType(_node) {
    // Ruby is dynamically typed; no type annotations in standard Ruby
    return undefined;
  },

  extractVisibility(node) {
    // attr_accessor/attr_writer fields are effectively public
    // attr_reader fields are read-only from outside but still public
    return 'public';
  },

  isStatic(_node) {
    return false;
  },

  isReadonly(node) {
    const method = node.childForFieldName('method');
    return method?.text === 'attr_reader';
  },
};
