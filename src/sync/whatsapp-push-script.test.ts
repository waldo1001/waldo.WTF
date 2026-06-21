import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// bin/wtf-whatsapp-push pushes WhatsApp exports from a capture Mac to the
// waldo.WTF server's inbox over scp. After the NAS→Mac mini migration the
// target is the Mac mini, and the NAS-specific env var names are misnomers.
// These tests pin the resolved scp target (host:inbox) the script prints,
// covering the new WTF_PUSH_* vars, the Mac-mini defaults, and backward
// compatibility with the legacy WTF_NAS_* names.

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SCRIPT = path.join(REPO_ROOT, "bin", "wtf-whatsapp-push");

const MACMINI_HOST = "waldomacmini1.tailb07704.ts.net";
const MACMINI_INBOX = "/Users/waldo/waldo-wtf/whatsapp-inbox";

function runPush(extraEnv: Record<string, string>): string {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "wtf-push-"));
  const binDir = path.join(tmp, "bin");
  const srcDir = path.join(tmp, "src");
  const trashDir = path.join(tmp, "trash");
  mkdirSync(binDir);
  mkdirSync(srcDir);
  mkdirSync(trashDir);

  // Stub the side-effecting externals so the script runs offline and fast:
  // scp succeeds without a network, sleep returns immediately.
  for (const name of ["scp", "sleep"]) {
    const p = path.join(binDir, name);
    writeFileSync(p, "#!/bin/sh\nexit 0\n");
    chmodSync(p, 0o755);
  }
  // A matching export so the script reaches the "scp to host:inbox" line.
  writeFileSync(path.join(srcDir, "WhatsApp Chat - Test.txt"), "hi\n");

  return execFileSync("bash", [SCRIPT], {
    encoding: "utf8",
    env: {
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
      HOME: tmp,
      WTF_WHATSAPP_SRC: srcDir,
      WTF_WHATSAPP_TRASH: trashDir,
      ...extraEnv,
    },
  });
}

describe("wtf-whatsapp-push target resolution", () => {
  it("uses WTF_PUSH_HOST / WTF_PUSH_INBOX when set", () => {
    const out = runPush({
      WTF_PUSH_HOST: "pushhost.example",
      WTF_PUSH_INBOX: "/srv/inbox",
    });
    expect(out).toContain("scp to pushhost.example:/srv/inbox/");
  });

  it("defaults to the Mac mini host + inbox when nothing is set", () => {
    const out = runPush({});
    expect(out).toContain(`scp to ${MACMINI_HOST}:${MACMINI_INBOX}/`);
  });

  it("still honors legacy WTF_NAS_HOST / WTF_NAS_INBOX (backward compat)", () => {
    const out = runPush({
      WTF_NAS_HOST: "legacy.nas",
      WTF_NAS_INBOX: "/volume1/old/inbox",
    });
    expect(out).toContain("scp to legacy.nas:/volume1/old/inbox/");
  });

  it("prefers WTF_PUSH_* over legacy WTF_NAS_* when both are set", () => {
    const out = runPush({
      WTF_PUSH_HOST: "newhost",
      WTF_PUSH_INBOX: "/new/inbox",
      WTF_NAS_HOST: "legacy.nas",
      WTF_NAS_INBOX: "/volume1/old/inbox",
    });
    expect(out).toContain("scp to newhost:/new/inbox/");
  });
});
