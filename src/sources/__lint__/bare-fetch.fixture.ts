// Lint regression fixture. Imported by src/__meta__/lint-bare-fetch.test.ts
// to verify that the no-restricted-globals rule fires on bare `fetch` in
// src/sources/**. Do NOT remove the bare fetch call below — it is the
// thing under test.

export async function intentionallyBareFetch(): Promise<unknown> {
  const res = await fetch("https://example.invalid/");
  return res;
}
