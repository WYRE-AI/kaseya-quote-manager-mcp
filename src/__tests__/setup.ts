import { beforeEach } from 'vitest';
import { resetLimiters } from '../utils/rate-limit.js';

// The shared 60-a-minute limiter would make a test file that makes many calls wait. Tests that
// exercise the limiter itself call resetLimiters() with the real limits.
beforeEach(() => {
  resetLimiters({ limit: 1_000_000 });
});
