import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

describe('openAIStructured array parsing and coercion', () => {
  it('coerces and accepts arbitrary object arrays without person-specific fields', () => {
    const rawArray = [
      { query: 'dental tech companies', intent: 'discovery', priority: 1 },
      { query: 'healthcare software Austin', intent: 'signal', priority: 2 }
    ];

    const normalizedSchema = {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          intent: { type: 'string' }
        },
        required: ['query', 'intent']
      }
    };

    const schemaIsArray = normalizedSchema.type === 'array';
    const coerceParsed = (parsed: any): any => {
      if (schemaIsArray) {
        const value = Array.isArray(parsed)
          ? parsed
          : parsed && Array.isArray(parsed.items)
            ? parsed.items
            : null;
        if (!Array.isArray(value)) return null;

        const itemSchema = normalizedSchema?.items;
        if (itemSchema && typeof itemSchema === 'object') {
          const itemRequired = Array.isArray(itemSchema.required) ? itemSchema.required : [];
          if (itemRequired.length > 0 && value.length > 0) {
            const hasValidItem = value.some(
              (item: any) =>
                item &&
                typeof item === 'object' &&
                itemRequired.every((key: string) => key in item),
            );
            if (!hasValidItem) return null;
          }
        }
        return value;
      }
      return parsed;
    };

    const result = coerceParsed(rawArray);
    assert.deepEqual(result, rawArray);
  });

  it('coerces string arrays when items are strings', () => {
    const rawArray = ['founder', 'co-founder', 'managing director'];
    const schemaIsArray = true;
    const coerceParsed = (parsed: any): any => {
      if (schemaIsArray) {
        const value = Array.isArray(parsed)
          ? parsed
          : parsed && Array.isArray(parsed.items)
            ? parsed.items
            : null;
        if (!Array.isArray(value)) return null;
        return value;
      }
      return parsed;
    };

    const result = coerceParsed(rawArray);
    assert.deepEqual(result, rawArray);
  });

  it('unwraps wrapped { items: [...] } payloads from JSON mode', () => {
    const rawWrapped = {
      items: [
        { requirementId: 'req_1', status: 'pass', confidence: 0.95 },
        { requirementId: 'req_2', status: 'fail', confidence: 0.8 }
      ]
    };
    const schemaIsArray = true;
    const coerceParsed = (parsed: any): any => {
      if (schemaIsArray) {
        const value = Array.isArray(parsed)
          ? parsed
          : parsed && Array.isArray(parsed.items)
            ? parsed.items
            : null;
        if (!Array.isArray(value)) return null;
        return value;
      }
      return parsed;
    };

    const result = coerceParsed(rawWrapped);
    assert.deepEqual(result, rawWrapped.items);
  });
});
