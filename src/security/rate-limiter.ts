export class RateLimiter {
  readonly #clients = new Map<string, { count: number; reset: number }>();
  constructor(private readonly limit = 120, private readonly windowMs = 60_000) {}
  allow(key: string): boolean { const now = Date.now(); const state = this.#clients.get(key); if (!state || state.reset <= now) { this.#clients.set(key, { count: 1, reset: now + this.windowMs }); return true; } if (state.count >= this.limit) return false; state.count++; return true; }
}
