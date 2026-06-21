import { SourceHandlers } from '../../handlers/SourceHandlers';
import { ObjectHandlers } from '../../handlers/ObjectHandlers';
import { RunHandlers } from '../../handlers/RunHandlers';
import { TransportHandlers } from '../../handlers/TransportHandlers';
import { DataHandlers } from '../../handlers/DataHandlers';
import { QualityHandlers } from '../../handlers/QualityHandlers';
import { GitHandlers } from '../../handlers/GitHandlers';
import { SystemHandlers } from '../../handlers/SystemHandlers';
import { DdicHandlers } from '../../handlers/DdicHandlers';
import type { ToolDefinition } from '../../types/tools';

/**
 * Collect all tool definitions without a real ADT client.
 * getTools() returns static definitions — no client needed.
 */
function getAllTools(): Array<{ handlerName: string; tool: ToolDefinition; handler: any }> {
  const entries = [
    { name: 'SourceHandlers',    cls: SourceHandlers },
    { name: 'ObjectHandlers',    cls: ObjectHandlers },
    { name: 'RunHandlers',       cls: RunHandlers },
    { name: 'TransportHandlers', cls: TransportHandlers },
    { name: 'DataHandlers',      cls: DataHandlers },
    { name: 'QualityHandlers',   cls: QualityHandlers },
    { name: 'GitHandlers',       cls: GitHandlers },
    { name: 'SystemHandlers',    cls: SystemHandlers },
    { name: 'DdicHandlers',      cls: DdicHandlers },
  ];

  const result: Array<{ handlerName: string; tool: ToolDefinition; handler: any }> = [];
  for (const { name, cls } of entries) {
    const handler = new cls(null as any);
    for (const tool of handler.getTools()) {
      result.push({ handlerName: name, tool, handler });
    }
  }
  return result;
}

describe('tool definitions: structural integrity', () => {
  const allTools = getAllTools();

  it('every tool has a non-empty name', () => {
    for (const { tool } of allTools) {
      expect(typeof tool.name).toBe('string');
      expect(tool.name.length).toBeGreaterThan(0);
    }
  });

  it('every tool has a non-empty description', () => {
    for (const { tool } of allTools) {
      expect(typeof tool.description).toBe('string');
      expect(tool.description.length).toBeGreaterThan(0);
    }
  });

  it('every tool has inputSchema.type = "object"', () => {
    for (const { tool } of allTools) {
      expect(tool.inputSchema.type).toBe('object');
    }
  });

  it('no duplicate tool names across all handlers', () => {
    const names = allTools.map(({ tool }) => tool.name);
    expect(names.length).toBe(new Set(names).size);
  });

  it('required fields are all listed in properties', () => {
    for (const { tool } of allTools) {
      const required = tool.inputSchema.required || [];
      const props = Object.keys(tool.inputSchema.properties || {});
      for (const field of required) {
        expect(props).toContain(field);
      }
    }
  });

  it('total tool count matches expected', () => {
    // Update this if tools are added or removed
    expect(allTools.length).toBeGreaterThanOrEqual(20);
  });
});

describe('validateAndHandle: missing required params produce clean errors', () => {
  const allTools = getAllTools();

  // For each tool that has required fields, verify that calling with {} throws
  // a clean McpError mentioning "missing required parameter" and the field names.
  for (const { tool, handler } of allTools) {
    const required = tool.inputSchema.required || [];
    if (required.length === 0) continue;

    it(`${tool.name}: rejects empty args`, async () => {
      await expect(handler.validateAndHandle(tool.name, {}))
        .rejects.toThrow(/missing required parameter/);
    });

    it(`${tool.name}: error lists all missing field names`, async () => {
      try {
        await handler.validateAndHandle(tool.name, {});
        fail('Should have thrown');
      } catch (e: any) {
        for (const field of required) {
          expect(e.message).toContain(field);
        }
      }
    });

    // Verify that passing ONE required field still reports the others as missing
    if (required.length > 1) {
      it(`${tool.name}: partial args still reports remaining missing fields`, async () => {
        const partial: any = { [required[0]]: 'test_value' };
        try {
          await handler.validateAndHandle(tool.name, partial);
          fail('Should have thrown');
        } catch (e: any) {
          // The first required field should NOT be in the error
          // The remaining should be listed
          for (const field of required.slice(1)) {
            expect(e.message).toContain(field);
          }
        }
      });
    }
  }
});

describe('validateAndHandle: tools with no required fields', () => {
  const allTools = getAllTools();
  const noRequired = allTools.filter(({ tool }) => (tool.inputSchema.required || []).length === 0);

  for (const { tool, handler } of noRequired) {
    it(`${tool.name}: accepts empty args without validation error`, async () => {
      // This will proceed past validation to the handler, which will likely fail
      // because the ADT client is null. The key assertion: it does NOT throw a
      // "missing required parameter" error.
      try {
        await handler.validateAndHandle(tool.name, {});
      } catch (e: any) {
        expect(e.message).not.toContain('missing required parameter');
      }
    });
  }
});
