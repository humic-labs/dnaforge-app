import { z } from 'zod';
import { jsonObjectSchema } from '../../shared/json-value';
import { describe, expect, it } from 'vitest';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv-provider.js';
import { portableToolSchema, wrapRendererOutputSchema } from './tool-json-schema';

describe('renderer output envelope references', () => {
  it('preserves local schema references when embedding successful data', () => {
    const output = {
      type: 'object',
      required: ['left', 'right', 'metadata'],
      additionalProperties: false,
      properties: {
        left: { $ref: '#/$defs/value' },
        right: { $ref: '#/$defs/value' },
        metadata: { const: { $ref: '#/literal-data' } },
      },
      $defs: {
        value: {
          type: 'object',
          properties: { id: { type: 'string' } },
          required: ['id'],
          additionalProperties: false,
        },
      },
    };
    const original = structuredClone(output);
    const wrapped = wrapRendererOutputSchema(output);
    const validate = new AjvJsonSchemaValidator().getValidator(wrapped);
    expect(
      validate({
        ok: true,
        result: { left: { id: 'a' }, right: { id: 'b' }, metadata: { $ref: '#/literal-data' } },
      }).valid
    ).toBe(true);
    expect(
      validate({
        ok: true,
        result: { left: { id: 7 }, right: { id: 'b' }, metadata: { $ref: '#/literal-data' } },
      }).valid
    ).toBe(false);
    expect(output).toEqual(original);
  });
});

it('keeps recursive provider JSON data valid after the MCP output envelope is added', () => {
  const schema = wrapRendererOutputSchema(
    portableToolSchema(z.object({ metadata: jsonObjectSchema }))
  );
  const validate = new AjvJsonSchemaValidator().getValidator(schema);
  expect(
    validate({ ok: true, result: { metadata: { nested: [null, 1, 'value', { enabled: true }] } } })
      .valid
  ).toBe(true);
  expect(validate({ ok: true, result: { metadata: { invalid: () => 'not JSON' } } }).valid).toBe(
    false
  );
  expect(
    validate({ ok: true, result: { metadata: { nested: [{ invalid: () => 'not JSON' }] } } }).valid
  ).toBe(false);
});
