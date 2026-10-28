/**
 * Fixed-window in-memory rate limiter.
 *
 * Used to protect the signaling server from abusive connection attempts.
 * State lives in process memory: restarting the server resets all counters,
 * which is acceptable for a small self-hosted relay.
 */

export function createRateLimiter({ points, windowMs, now = () => Date.now() } = {}) {
  if (!Number.isFinite(points) || points < 1) throw new Error('points must be >= 1');
  if (!Number.isFinite(windowMs) || windowMs < 1) throw new Error('windowMs must be >= 1');

  /** @type {Map<string, {count:number, resetAt:number}>} */
  const buckets = new Map();

  function prune(currentTime) {
    if (buckets.size < 10_000) return;
    for (const [key, bucket] of buckets) {
      if (bucket.resetAt <= currentTime) buckets.delete(key);
    }
  }

  return {
    /** @returns {boolean} true when the key is within its allowance */
    consume(key, cost = 1) {
      const currentTime = now();
      prune(currentTime);
      let bucket = buckets.get(key);
      if (!bucket || bucket.resetAt <= currentTime) {
        bucket = { count: 0, resetAt: currentTime + windowMs };
        buckets.set(key, bucket);
      }
      if (bucket.count + cost > points) return false;
      bucket.count += cost;
      return true;
    },

    /** Milliseconds until `key` is allowed again, or 0. */
    retryAfter(key) {
      const bucket = buckets.get(key);
      if (!bucket) return 0;
      return Math.max(0, bucket.resetAt - now());
    },

    reset(key) {
      buckets.delete(key);
    },

    get size() {
      return buckets.size;
    },
  };
}
