// Escapes SQL LIKE metacharacters (%, _) plus the escape char itself so a
// literal % or _ in a user-supplied filter string is matched literally,
// not treated as a wildcard. Paired with `LIKE ? ESCAPE '\'` at call sites.
export const escapeLikePattern = (raw: string): string =>
  raw.replace(/[\\%_]/g, (c) => `\\${c}`);
