// Example: fake Clock for deterministic time in unit tests.
// Port to src/testing/fake-clock.ts at Weekend 2.
// Reference: ../../docs/tdd/testability-patterns.md §3.3

export interface Clock {
  now(): number; // unix ms
}

export class FakeClock implements Clock {
  private ms: number;

  constructor(isoOrMs: string | number) {
    this.ms = typeof isoOrMs === "string" ? Date.parse(isoOrMs) : isoOrMs;
    if (Number.isNaN(this.ms)) {
      throw new Error(`FakeClock: invalid time input: ${String(isoOrMs)}`);
    }
  }

  now(): number {
    return this.ms;
  }

  advance(deltaMs: number): void {
    if (deltaMs < 0) throw new Error("FakeClock.advance: deltaMs must be >= 0");
    this.ms += deltaMs;
  }

  setTo(isoOrMs: string | number): void {
    this.ms = typeof isoOrMs === "string" ? Date.parse(isoOrMs) : isoOrMs;
  }
}
