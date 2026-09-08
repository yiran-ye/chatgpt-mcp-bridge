import { Ajv } from 'ajv';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormatsImport from 'ajv-formats';
import type { jsonSchemaValidator, JsonSchemaType, JsonSchemaValidator } from '@modelcontextprotocol/sdk/validation';
import { AppError } from '../shared/errors.js';

const addFormats = addFormatsImport as unknown as (ajv: Ajv | Ajv2020) => void;

/** Each schema gets an isolated compiler: equal upstream $ids must not share validators. */
export class McpSchemaValidator implements jsonSchemaValidator {
  getValidator<T>(schema: JsonSchemaType): JsonSchemaValidator<T> {
    try {
      assertSafeSchema(schema);
      const options = { strict: false, logger: false, validateSchema: true, validateFormats: true, allErrors: false, coerceTypes: false, useDefaults: false, removeAdditional: false } as const;
      const ajv = schema.$schema?.includes('draft-07') ? new Ajv(options) : new Ajv2020(options);
      addFormats(ajv);
      const validate = ajv.compile(schema);
      return (input: unknown) => validate(input)
        ? { valid: true, data: input as T, errorMessage: undefined }
        : { valid: false, data: undefined, errorMessage: '工具参数或结果不符合上游 JSON Schema' };
    } catch { throw new AppError('MCP_SCHEMA_INVALID', '上游工具 JSON Schema 无效或不受支持'); }
  }
}

function assertSafeSchema(schema: unknown): void {
  if (Buffer.byteLength(JSON.stringify(schema)) > 256 * 1024) throw new Error();
  let nodes = 0;
  const visit = (value: unknown, depth: number): void => {
    if (++nodes > 20_000 || depth > 64) throw new Error();
    if (Array.isArray(value)) { for (const child of value) visit(child, depth + 1); return; }
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      if (key === '$async' || ((key === '$ref' || key === '$dynamicRef' || key === '$recursiveRef') && (typeof child !== 'string' || !child.startsWith('#')))) throw new Error();
      visit(child, depth + 1);
    }
  };
  visit(schema, 0);
}
