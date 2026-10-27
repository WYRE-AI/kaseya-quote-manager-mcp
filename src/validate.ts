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

const ISO_8601 = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{3})?)?(?:Z|([+-])(\d{2}):(\d{2}))?)?$/;

/** Strict ISO 8601: YYYY-MM-DD or YYYY-MM-DDTHH:MM[:SS[.fff]] with optional Z or ±HH:MM. Impossible dates fail. */
export function isIsoDateTime(value: string): boolean {
  const m = ISO_8601.exec(value);
  if (!m) return false;
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  // Round trip through Date: 2026-02-30 would come back as March 2.
  const d = new Date(0);
  d.setUTCFullYear(year, month - 1, day);
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) return false;
  if (m[4] !== undefined && (Number(m[4]) > 23 || Number(m[5]) > 59)) return false;
  if (m[6] !== undefined && Number(m[6]) > 59) return false;
  if (m[7] !== undefined && (Number(m[8]) > 23 || Number(m[9]) > 59)) return false;
  return true;
}

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
    if (name === 'modifiedAfter' && !isIsoDateTime(value as string)) bad(MODIFIED_AFTER_ERROR);
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
