# Runbooks

Manual operational procedures. Each one lives as a single file and is
written so an operator can follow it cold (with terminal access to
either waldo's Mac or the NAS) without prior context.

A runbook is for procedures that:

- cannot reasonably be automated, OR
- are infrequent enough that the runbook *is* the institutional memory.

For ongoing development workflow see [../tdd/methodology.md](../tdd/methodology.md);
for setup see [../setup.md](../setup.md); for daily user operation see
[../user-guide.md](../user-guide.md).

## Index

- [autoheal-smoke.md](autoheal-smoke.md) — verify the
  `willfarrell/autoheal` sidecar restarts a wedged `waldo-wtf`
  container. Run after any change to `docker-compose.yml`.
