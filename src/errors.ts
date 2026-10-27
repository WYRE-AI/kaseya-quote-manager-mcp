import {
  AuthenticationError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
  RateLimitError,
  ServerError,
} from '@wyre-technology/node-kaseya-quote-manager';

/** Bad caller input. The message is fixed text that never echoes caller values. */
export class ToolArgumentError extends Error {}

/** No API key available for this request. The message is fixed text. */
export class CredentialsError extends Error {}

/** HTTP status of an SDK error, or undefined for anything else. */
export function errorStatus(err: unknown): number | undefined {
  const status = (err as { statusCode?: unknown } | null)?.statusCode;
  return typeof status === 'number' ? status : undefined;
}

/** Fixed, caller-safe text for a failed tool call. Never includes upstream text. */
export function toolErrorMessage(err: unknown): string {
  if (err instanceof ToolArgumentError || err instanceof CredentialsError) return err.message;
  const status = errorStatus(err);
  if (err instanceof AuthenticationError || status === 401) {
    return 'Quote Manager rejected the API key. Check the key and try again.';
  }
  if (err instanceof ForbiddenError || status === 403) {
    return 'This Quote Manager API key does not have access to that record or endpoint.';
  }
  if (err instanceof NotFoundError || status === 404) {
    return 'No Quote Manager record matches that ID. Check the ID with a list call.';
  }
  if (err instanceof ValidationError || status === 400) {
    return 'Quote Manager rejected the request. Check the arguments and try again.';
  }
  if (err instanceof RateLimitError || status === 429) {
    return 'Quote Manager rate limit reached (60 requests a minute, 10,000 a day). Wait and try again.';
  }
  if (err instanceof ServerError || (status !== undefined && status >= 500)) {
    return 'Quote Manager had a server error. Try again later.';
  }
  return 'Quote Manager request failed. Try again later.';
}

/** True for a 429 from Quote Manager. */
export function isRateLimitError(err: unknown): boolean {
  return err instanceof RateLimitError || errorStatus(err) === 429;
}

export const UNKNOWN_TOOL_MESSAGE =
  'Unknown tool. Call conduit__my_access to see which tools you can use under the gateway, or kqm_navigate to browse available tools when running standalone.';
