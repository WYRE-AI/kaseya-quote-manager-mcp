import { AsyncLocalStorage } from 'node:async_hooks';
import { KaseyaQuoteManagerClient } from '@wyre-ai/node-kaseya-quote-manager';
import { CredentialsError } from '../errors.js';

export interface Credentials { apiKey: string; }

// Request-scoped credential store. In gateway mode the HTTP layer runs each
// request inside runWithCredentials({apiKey}); getCredentials() reads it.
// Stdio and HTTP env mode fall back to process.env.
const credStore = new AsyncLocalStorage<Credentials>();

// Set by startHttpServer. In gateway mode process.env is never a credential source.
let gatewayMode = false;

export function setGatewayMode(on: boolean): void {
  gatewayMode = on;
}

export function runWithCredentials<T>(creds: Credentials, fn: () => T): T {
  return credStore.run(creds, fn);
}

export function getCredentials(): Credentials | null {
  const scoped = credStore.getStore();
  if (scoped?.apiKey) return scoped;
  if (gatewayMode) return null;
  const apiKey = process.env.KASEYA_QUOTE_MANAGER_API_KEY;
  if (!apiKey) return null;
  return { apiKey };
}

// Constructs a client from the request-scoped (or env) credentials. The client
// is cheap and holds no shared mutable state, so we build one per call — never
// a process-global singleton.
export function getClient(options: { maxRetries?: number } = {}): KaseyaQuoteManagerClient {
  const creds = getCredentials();
  if (!creds) {
    throw new CredentialsError(
      gatewayMode
        ? 'No Quote Manager API key on this request. Reconnect Quote Manager with an API key, or check that the gateway sends the X-Kaseya-Quote-Manager-Api-Key header.'
        : 'No Quote Manager API key configured. Set KASEYA_QUOTE_MANAGER_API_KEY.',
    );
  }
  return new KaseyaQuoteManagerClient({ apiKey: creds.apiKey, maxRetries: options.maxRetries });
}
