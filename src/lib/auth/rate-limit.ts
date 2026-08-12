const WINDOW_MS = 5 * 60 * 1000;
const MAX_ATTEMPTS = 10;

interface Bucket {
  count: number;
  windowStart: number;
}

// In-memory per-instance limiter. On Vercel's Fluid Compute this persists
// across requests handled by the same warm instance but is not shared across
// instances or survives cold starts — a real bound, not a perfect one, but it
// meaningfully raises the cost of brute-forcing the single admin password
// without adding a paid external store for a single-user app.
const buckets = new Map<string, Bucket>();

/** Returns true if this key is currently allowed to attempt a login. */
export function checkLoginRateLimit(key: string): boolean {
  const now = Date.now();
  const bucket = buckets.get(key);

  if (!bucket || now - bucket.windowStart > WINDOW_MS) {
    buckets.set(key, { count: 1, windowStart: now });
    return true;
  }

  if (bucket.count >= MAX_ATTEMPTS) {
    return false;
  }

  bucket.count += 1;
  return true;
}
