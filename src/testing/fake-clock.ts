import type { Clock } from "../clock.js";

export class FakeClock implements Clock {
  private current: Date;

  constructor(initial: Date) {
    this.current = new Date(initial.getTime());
  }

  now(): Date {
    return new Date(this.current.getTime());
  }

  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }

  set(d: Date): void {
    this.current = new Date(d.getTime());
  }
}
