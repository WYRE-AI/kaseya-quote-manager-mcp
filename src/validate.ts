import { ToolArgumentError } from './errors.js';

interface PropSchema {
  type?: string;
  minimum?: number;
  maximum?: number;
  maxLength?: number;
  enum?: unknown[];
}
export interface ObjectSchema {
  properties?: Record<string, unknown>;
  required?: string[];
}

const isIdName = (name: string) => name === 'id' || /(ID|Id)$/.test(name);

const MODIFIED_AFTER_ERROR =
  'Invalid modifiedAfter. Use an ISO 8601 date or timestamp, for example 2026-01-31T00:00:00Z.';

function checkValue(name: string, prop: PropSchema, value: unknown): void {
  const bad = (message: string): never => {
    throw new ToolArgumentError(message);
  };
  if (prop.type === 'integer') {
    const { minimum: min, maximum: max } = prop;
    if (
      typeof value !== 'number' ||
      !Number.isSafeInteger(value) ||
      (min !== undefined && value < min) ||
      (max !== undefined && value > max)
    ) {
      if (isIdName(name)) bad(`Invalid ${name}. Use a positive whole-number ID from a list or get call.`);
      if (min !== undefined && max !== undefined) bad(`Invalid ${name}. Use a whole number from ${min} to ${max}.`);
      bad(`Invalid ${name}. Use a whole number of ${min ?? 0} or more.`);
    }
  } else if (prop.type === 'string') {
    if (typeof value !== 'string' || (prop.maxLength !== undefined && value.length > prop.maxLength)) {
      bad(`Invalid ${name}. Use text up to ${prop.maxLength ?? 256} characters.`);
    }
    if (prop.enum && !prop.enum.includes(value)) bad(`Invalid ${name}. Use one of: ${prop.enum.join(', ')}.`);
    if (name === 'modifiedAfter' && Number.isNaN(Date.parse(value as string))) bad(MODIFIED_AFTER_ERROR);
  } else if (prop.type === 'boolean') {
    if (typeof value !== 'boolean') bad(`Invalid ${name}. Use true or false.`);
  } else {
    bad(`Invalid ${name}. Check the tool input schema.`);
  }
}

/**
 * Check `args` against a tool input schema. Messages carry schema property names
 * only; caller-supplied keys and values are never echoed.
 */
export function validateArgs(schema: ObjectSchema, args: Record<string, unknown>): void {
  const props = (schema.properties ?? {}) as Record<string, PropSchema>;
  for (const key of Object.keys(args)) {
    if (!Object.hasOwn(props, key)) {
      throw new ToolArgumentError(
        'Unknown argument. Remove arguments that are not in the tool input schema.',
      );
    }
  }
  for (const name of schema.required ?? []) {
    if (args[name] === undefined) throw new ToolArgumentError(`Missing required argument: ${name}. Add it and try again.`);
  }
  for (const [name, value] of Object.entries(args)) {
    if (value !== undefined) checkValue(name, props[name], value);
  }
}

/** Defensive ID check for get handlers: only positive safe integers reach the SDK. */
export function requireId(value: unknown, name = 'id'): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new ToolArgumentError(`Invalid ${name}. Use a positive whole-number ID from a list or get call.`);
  }
  return value;
}
