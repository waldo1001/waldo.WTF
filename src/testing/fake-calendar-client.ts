import type {
  CalendarClient,
  CalendarViewDeltaInput,
  CalendarViewDeltaPage,
} from "../sources/calendar.js";

// Thrown when the sync loop (or a test) passes a cursor the fixture never
// scripted a page for — surfaces loop bugs (wrong cursor threaded through)
// immediately instead of silently returning nothing.
export class UnknownCalendarCursorError extends Error {}

// Thrown when a call is made for an account outside the fixture's
// allow-list — catches cross-test fixture bleed and account-string typos.
export class UnknownCalendarAccountError extends Error {}

const INITIAL_CURSOR_KEY = "__initial__";

export interface FakeCalendarClientOptions {
  // Keyed by cursor. The initial call (no cursor on the input) looks up
  // "__initial__". Every subsequent call's cursor is whatever nextLink or
  // deltaLink the previous page handed back — so scripting page N+1 means
  // keying it by page N's nextLink/deltaLink value.
  readonly pages: Readonly<Record<string, CalendarViewDeltaPage>>;
  readonly allowedAccounts: readonly string[];
}

export class FakeCalendarClient implements CalendarClient {
  readonly calls: CalendarViewDeltaInput[] = [];
  private readonly pages: Readonly<Record<string, CalendarViewDeltaPage>>;
  private readonly allowedAccounts: ReadonlySet<string>;

  constructor(opts: FakeCalendarClientOptions) {
    this.pages = opts.pages;
    this.allowedAccounts = new Set(opts.allowedAccounts);
  }

  async listCalendarViewDelta(
    input: CalendarViewDeltaInput,
  ): Promise<CalendarViewDeltaPage> {
    this.calls.push(input);
    if (!this.allowedAccounts.has(input.account)) {
      throw new UnknownCalendarAccountError(
        `FakeCalendarClient: account not in allow-list: ${input.account}`,
      );
    }
    const key = input.cursor ?? INITIAL_CURSOR_KEY;
    const page = this.pages[key];
    if (page === undefined) {
      throw new UnknownCalendarCursorError(
        `FakeCalendarClient: no scripted page for cursor "${key}"`,
      );
    }
    return page;
  }
}
