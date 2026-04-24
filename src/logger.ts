import type { Clock } from "./clock.js";

export interface Logger {
  info(message: string): void;
  error(message: string): void;
}

/**
 * @deprecated Prefer `createTimestampedConsoleLogger(clock)` for
 * production wiring — it prefixes every line with an ISO-UTC timestamp
 * so `docker compose logs` / `tee`'d output / screenshots all show
 * *when* each line was emitted. Kept for tests and one-shot CLI
 * callers where clock injection is overkill.
 */
export const consoleLogger: Logger = {
  info(message) {
    console.log(message);
  },
  error(message) {
    console.error(message);
  },
};

export function createTimestampedConsoleLogger(clock: Clock): Logger {
  const prefix = (): string => `[${clock.now().toISOString()}] `;
  return {
    info(message) {
      console.log(`${prefix()}${message}`);
    },
    error(message) {
      console.error(`${prefix()}${message}`);
    },
  };
}
