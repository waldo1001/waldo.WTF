# Plan: fix --viva-discover to return joined communities (mine=1)

## Task
Change `listCommunities` to pass `?mine=1` to the Yammer groups API so it
returns only groups the user has joined, instead of suggested/popular groups
— fixing the case where a guest in an external network (e.g. Microsoft's
Viva Engage) sees "no viva communities visible" despite having joined
communities there. Also add a "Found N network(s): [names]" diagnostic
line to `--viva-discover` output.

## Scope boundary

**In scope:**
- `src/sources/http-yammer-client.ts` — add `mine=1` to the `/groups.json`
  URL in `listCommunities`
- `src/sources/http-yammer-client.test.ts` — update URL expectation +
  add test explicitly covering external-network guest case
- `src/cli.ts` — add verbose "Found N network(s): [names]" print in
  `discoverAllCommunities`
- `src/cli.test.ts` — cover the new verbose output line

**Out of scope:**
- Restructuring `listCommunities` to remove the `networkId` parameter
- Fetching all networks' communities in a single API call
- Handling cases where `mine=1&network_id={id}` does not filter correctly
  (will diagnose in production; next slice if needed)

## Files to touch

- `src/sources/http-yammer-client.ts`
- `src/sources/http-yammer-client.test.ts`
- `src/cli.ts`
- `src/cli.test.ts`

## Seams involved

`http`

## RED test list

- AC1: `listCommunities` URL includes `mine=1`
  - test file: `src/sources/http-yammer-client.test.ts`
  - test name: "listCommunities uses mine=1 to return only groups the user has joined"
  - seams: http
  - edge case: URL must include both `mine=1` AND `network_id=` and `page=1`

- AC2: `--viva-discover` prints "Found N network(s): [names]" before the community table
  - test file: `src/cli.test.ts`
  - test name: "--viva-discover prints network count and names before community table"
  - seams: none (tests print callback)
  - edge case: 0 networks → "Found 0 network(s)" still printed

## Open questions / assumptions

- **Assumption**: `?mine=1&network_id={id}` is a valid Yammer API combination that
  correctly filters to only groups the user has joined in that specific network.
  If Yammer ignores `network_id` when `mine=1` is set and returns groups from
  other networks, the client-side `networkId` field in each group response will
  still correctly identify which network it belongs to (already parsed). If that
  turns out to be wrong, a follow-up slice can restructure the API call.
- **Assumption**: The verbose print is part of the `discoverAllCommunities`
  function output, printed via the existing `print` callback in `discoverForAccount`.

## Risks

- If `?mine=1&network_id={id}` causes a 400/500 error on some Yammer networks,
  the discover command would break for all users. Mitigation: the existing
  error handling already catches non-200 responses and throws descriptive errors.
- If `mine=1` scoped to a network returns an empty page 1 even for joined groups
  (e.g. different sorting), pagination already handles this correctly (loop until
  empty).

## Out-of-scope follow-ups

- If `mine=1&network_id={id}` doesn't work for external networks, restructure
  `listCommunities` to drop `networkId` param and call `?mine=1` once, then
  match groups to networks client-side by `network_id` field.
- `--viva-discover --verbose` flag for even more diagnostic output (network IDs,
  community IDs before filtering)
