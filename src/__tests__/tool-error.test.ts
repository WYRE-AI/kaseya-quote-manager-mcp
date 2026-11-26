import { describe, it, expect } from 'vitest';
import { formatToolError } from '../server.js';

describe('formatToolError', () => {
  it('includes the vendor status code when the error carries one', () => {
    class NotFoundError extends Error {
      statusCode = 404;
    }
    expect(formatToolError(new NotFoundError('Resource not found'))).toBe('Error (HTTP 404): Resource not found');
    expect(formatToolError(Object.assign(new Error('Too many requests'), { statusCode: 429 }))).toBe('Error (HTTP 429): Too many requests');
  });

  it('reports the vendor 5xx status that the client folds into 500', () => {
    const serverError = (msg: string) => Object.assign(new Error(msg), { statusCode: 500 });
    expect(formatToolError(serverError('Server error: 503'))).toBe('Error (HTTP 503): Server error: 503');
    expect(formatToolError(serverError('Server error: 500'))).toBe('Error (HTTP 500): Server error: 500');
    expect(formatToolError(serverError('Internal failure'))).toBe('Error (HTTP 500): Internal failure');
    expect(formatToolError(Object.assign(new Error('Server error: 503'), { statusCode: 404 }))).toBe('Error (HTTP 404): Server error: 503');
  });

  it('keeps the plain message for errors without a status code', () => {
    expect(formatToolError(new Error('boom'))).toBe('Error: boom');
    expect(formatToolError('text')).toBe('Error: text');
    expect(formatToolError(null)).toBe('Error: null');
  });
});
