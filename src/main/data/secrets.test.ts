import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The secrets store over a stand-in safeStorage: "encryption" reverses the text and marks it, so
// a test can tell what reached the file; each test a fresh userData and fresh modules. The stand-in
// has only the async calls (0.15.0: the sync ones are deprecated in Electron 45 and gone in 46), so
// a sync call anywhere in the store fails here. A value marked "old:" decrypts as one whose key has
// moved on (shouldReEncrypt), and "bad:" as one this system cannot decrypt.
let userData = "";
let available = true;
// every call that could reach the keychain, counted (0.14.0: a launch that needs no secret
// touches none)
const touched = { available: 0, encrypt: 0, decrypt: 0 };
vi.mock("electron", () => ({
  app: { getPath: () => userData, getVersion: () => "0.0.0", isPackaged: false, on: () => {} },
  safeStorage: {
    isAsyncEncryptionAvailable: () => (touched.available++, Promise.resolve(available)),
    getSelectedStorageBackend: () => "keychain",
    encryptStringAsync: (s: string) => (
      touched.encrypt++,
      Promise.resolve(Buffer.from(`enc:${[...s].reverse().join("")}`))
    ),
    decryptStringAsync: (b: Buffer) => {
      touched.decrypt++;
      const text = b.toString();
      if (text.startsWith("bad:")) return Promise.reject(new Error("another machine's keychain"));
      return Promise.resolve({
        result: [...text.replace(/^(enc|old):/, "")].reverse().join(""),
        shouldReEncrypt: text.startsWith("old:"),
      });
    },
  },
}));
const keychainUse = (): number => touched.available + touched.encrypt + touched.decrypt;

const fresh = async (): Promise<{
  secrets: typeof import("./secrets");
  persist: typeof import("./persist");
}> => {
  vi.resetModules();
  return { secrets: await import("./secrets"), persist: await import("./persist") };
};
const file = (name: string): string => readFileSync(join(userData, name), "utf8");

beforeEach(() => {
  userData = mkdtempSync(join(tmpdir(), "tt-secrets-"));
  available = true;
  touched.available = touched.encrypt = touched.decrypt = 0;
  delete process.env["TASTYTUNES_SECRETS_PLAIN"];
});

describe("the secrets store", () => {
  it("keeps a value encrypted in its own file, readable to its owner only, and gives it back", async () => {
    const { secrets } = await fresh();
    await secrets.setSecret("lbToken", "  abcd-1234-wxyz  ");
    expect(file("secrets.json")).not.toContain("abcd-1234-wxyz");
    // owner-only on a filesystem with modes; Windows has none (DPAPI's encryption protects it)
    if (process.platform !== "win32")
      expect(statSync(join(userData, "secrets.json")).mode & 0o777).toBe(0o600);
    const again = (await fresh()).secrets;
    expect(await again.getSecret("lbToken")).toBe("abcd-1234-wxyz");
    expect(await again.secretHint("lbToken")).toEqual({
      saved: true,
      ends: "wxyz",
      unreadable: false,
    });
  });

  it("forgets a value set blank or null", async () => {
    const { secrets } = await fresh();
    await secrets.setSecret("lbToken", "token-1");
    await secrets.setSecret("lbToken", null);
    expect(await secrets.getSecret("lbToken")).toBeNull();
    expect(await secrets.secretHint("lbToken")).toMatchObject({ saved: false, ends: null });
  });

  it("keeps a value unencrypted where nothing can encrypt, and says so", async () => {
    available = false;
    const { secrets } = await fresh();
    expect(await secrets.canEncrypt()).toBe(false);
    await secrets.setSecret("mcpToken", "plain-token");
    expect(
      (JSON.parse(file("secrets.json")) as { entries: Record<string, unknown> }).entries.mcpToken,
    ).toEqual({
      enc: false,
      value: "plain-token",
    });
    process.env["TASTYTUNES_SECRETS_PLAIN"] = "1";
    available = true;
    expect(await (await fresh()).secrets.canEncrypt()).toBe(false);
  });
});

describe("the tokens leave settings.json", () => {
  it("move into the store, and a later save never writes them back", async () => {
    writeFileSync(
      join(userData, "settings.json"),
      JSON.stringify({
        lbEnabled: true,
        lbToken: "lb-secret-9876",
        mcp: { enabled: true, token: "mcp-secret-5432" },
      }),
    );
    const { secrets, persist } = await fresh();
    await persist.moveSecrets();
    expect(await secrets.getSecret("lbToken")).toBe("lb-secret-9876");
    expect(await secrets.getSecret("mcpToken")).toBe("mcp-secret-5432");
    const settings = file("settings.json");
    expect(settings).not.toContain("secret");
    expect((JSON.parse(settings) as { mcp: { enabled: boolean } }).mcp.enabled).toBe(true);
    // a window's settings carry no token, and its save cannot add one back
    expect("lbToken" in persist.getSettings()).toBe(false);
    persist.updateSettings({
      lbToken: "x",
      mcp: { ...persist.getSettings().mcp, token: "y" },
    } as never);
    expect(file("settings.json")).not.toMatch(/lbToken|"token"/);
  });

  it("mint an MCP token only when the server first runs, and a new one on request", async () => {
    const { secrets, persist } = await fresh();
    await persist.moveSecrets();
    expect(await secrets.getSecret("mcpToken")).toBeNull();
    await persist.ensureMcpToken();
    const first = await secrets.getSecret("mcpToken");
    expect(first).toMatch(/^[\w-]{20,}$/);
    await persist.ensureMcpToken();
    expect(await secrets.getSecret("mcpToken")).toBe(first);
    await persist.newMcpToken();
    expect(await secrets.getSecret("mcpToken")).not.toBe(first);
  });

  it("take a token an older build wrote since as the newer one, while the server is on", async () => {
    const { secrets, persist } = await fresh();
    await persist.moveSecrets();
    // the installed 0.12.0 finds no token and mints its own into settings.json
    writeFileSync(
      join(userData, "settings.json"),
      JSON.stringify({ mcp: { enabled: true, token: "minted-by-0.12" } }),
    );
    const later = await fresh();
    await later.persist.moveSecrets();
    expect(await later.secrets.getSecret("mcpToken")).toBe("minted-by-0.12");
    expect(file("settings.json")).not.toContain("minted-by-0.12");
    void secrets;
  });

  it("drop the token 0.12.0 minted for an install that never turned the server on", async () => {
    writeFileSync(
      join(userData, "settings.json"),
      JSON.stringify({ mcp: { enabled: false, token: "minted-by-0.12" } }),
    );
    const { secrets, persist } = await fresh();
    await persist.moveSecrets();
    expect(await secrets.getSecret("mcpToken")).toBeNull();
    expect(file("settings.json")).not.toContain("minted-by-0.12");
    expect(keychainUse()).toBe(0);
  });
});

describe("the keychain only when a secret is used", () => {
  it("a launch with no secrets never reaches it, Settings' hints included", async () => {
    writeFileSync(join(userData, "settings.json"), JSON.stringify({ mcp: { enabled: false } }));
    const { secrets, persist } = await fresh();
    await persist.moveSecrets();
    expect(await secrets.secretHint("lbToken")).toMatchObject({ saved: false, ends: null });
    expect(await secrets.secretHint("mcpToken")).toMatchObject({ saved: false, ends: null });
    expect(await secrets.getSecret("fanartKey")).toBeNull();
    // where the platform's keychain is always there it is never asked; Linux asks for a keyring
    expect(await secrets.encryptsHere()).toBe(true);
    if (process.platform === "darwin" || process.platform === "win32")
      expect(keychainUse()).toBe(0);
    else expect(touched.encrypt + touched.decrypt).toBe(0);
  });

  it("decrypts an entry only when it is asked for, and a save leaves the others as stored", async () => {
    const first = await fresh();
    await first.secrets.setSecret("lbToken", "lb-token-1111");
    await first.secrets.setSecret("fanartKey", "fanart-2222");
    const before = JSON.parse(file("secrets.json")) as { entries: Record<string, unknown> };
    touched.available = touched.encrypt = touched.decrypt = 0;
    const { secrets } = await fresh();
    expect(secrets.hasSecret("lbToken")).toBe(true);
    expect(touched.decrypt).toBe(0);
    expect(await secrets.secretHint("fanartKey")).toMatchObject({ saved: true, ends: "2222" });
    expect(touched.decrypt).toBe(1);
    await secrets.setSecret("mcpToken", "mcp-3333");
    expect(touched.decrypt).toBe(1);
    const after = JSON.parse(file("secrets.json")) as { entries: Record<string, unknown> };
    expect(after.entries.lbToken).toEqual(before.entries.lbToken);
    expect(await (await fresh()).secrets.getSecret("lbToken")).toBe("lb-token-1111");
  });

  it("says unencrypted where the saved values are, without asking the keychain", async () => {
    available = false;
    await (await fresh()).secrets.setSecret("lbToken", "plain-1");
    available = true;
    touched.available = 0;
    expect(await (await fresh()).secrets.encryptsHere()).toBe(false);
    expect(touched.available).toBe(0);
  });
});

describe("safeStorage's async calls", () => {
  const storeWith = (entries: Record<string, { enc: boolean; value: string }>): void =>
    writeFileSync(join(userData, "secrets.json"), JSON.stringify({ v: 1, entries }));
  const b64 = (s: string): string => Buffer.from(s).toString("base64");

  it("two asks for one entry reach the keychain once", async () => {
    await (await fresh()).secrets.setSecret("lbToken", "lb-token-5555");
    touched.decrypt = 0;
    const { secrets } = await fresh();
    const [a, b] = await Promise.all([secrets.getSecret("lbToken"), secrets.getSecret("lbToken")]);
    expect([a, b]).toEqual(["lb-token-5555", "lb-token-5555"]);
    expect(touched.decrypt).toBe(1);
  });

  it("keeps a value under the keychain's new key when the old one has moved on", async () => {
    storeWith({ lbToken: { enc: true, value: b64("old:6666-nekot") } });
    const { secrets } = await fresh();
    expect(await secrets.getSecret("lbToken")).toBe("token-6666");
    const entry = (
      JSON.parse(file("secrets.json")) as { entries: Record<string, { value: string }> }
    ).entries.lbToken;
    expect(Buffer.from(entry.value, "base64").toString()).toBe("enc:6666-nekot");
    expect(await (await fresh()).secrets.getSecret("lbToken")).toBe("token-6666");
  });

  it("reads a value it cannot decrypt as unsaved once it knows, and keeps it on disk", async () => {
    storeWith({ lbToken: { enc: true, value: b64("bad:anything") } });
    const { secrets } = await fresh();
    expect(secrets.hasSecret("lbToken")).toBe(true);
    expect(await secrets.getSecret("lbToken")).toBeNull();
    expect(secrets.hasSecret("lbToken")).toBe(false);
    expect(await secrets.secretHint("lbToken")).toEqual({
      saved: false,
      ends: null,
      unreadable: true,
    });
    expect(file("secrets.json")).toContain(b64("bad:anything"));
    await secrets.setSecret("lbToken", "a-new-one-7777");
    expect(secrets.hasSecret("lbToken")).toBe(true);
  });

  it("tells a secret none saved from one saved that can't be read, and asks the keychain once", async () => {
    storeWith({ lbToken: { enc: true, value: b64("bad:anything") } });
    const { secrets } = await fresh();
    expect(await secrets.readSecret("fanartKey")).toEqual({ state: "absent" });
    touched.decrypt = 0;
    expect(await secrets.readSecret("lbToken")).toEqual({ state: "unreadable" });
    expect(await secrets.readSecret("lbToken")).toEqual({ state: "unreadable" });
    expect(await secrets.secretHint("lbToken")).toMatchObject({ unreadable: true });
    // each ask of the keychain could be another prompt: known, it isn't asked again this session
    expect(touched.decrypt).toBe(1);
    await secrets.setSecret("lbToken", "lb-token-4444");
    expect(await secrets.readSecret("lbToken")).toEqual({ state: "saved", value: "lb-token-4444" });
  });

  it("reads a blank decryption as unreadable, never as none saved", async () => {
    storeWith({ lbToken: { enc: true, value: b64("enc:") } });
    const { secrets } = await fresh();
    expect(await secrets.readSecret("lbToken")).toEqual({ state: "unreadable" });
    expect(secrets.hasSecret("lbToken")).toBe(false);
  });

  it("writes the file owner-only from the start, even over a temporary file a crash left", async () => {
    if (process.platform === "win32") return;
    const tmp = join(userData, `secrets.json.${process.pid}.tmp`);
    writeFileSync(tmp, "left by a crash", { mode: 0o644 });
    await (await fresh()).secrets.setSecret("mcpToken", "mcp-8888");
    expect(statSync(join(userData, "secrets.json")).mode & 0o777).toBe(0o600);
    expect(() => statSync(tmp)).toThrow();
  });
});

describe("a token that can't be read", () => {
  const storeWith = (entries: Record<string, { enc: boolean; value: string }>): void =>
    writeFileSync(join(userData, "secrets.json"), JSON.stringify({ v: 1, entries }));
  const b64 = (s: string): string => Buffer.from(s).toString("base64");
  const stored = (): Record<string, unknown> =>
    (JSON.parse(file("secrets.json")) as { entries: Record<string, unknown> }).entries;

  it("keeps the display's address as stored, and answers none, rather than mint a new one", async () => {
    storeWith({ displayToken: { enc: true, value: b64("bad:old-address") } });
    const before = stored();
    const { persist } = await fresh();
    expect(await persist.displayToken()).toBeNull();
    expect(await persist.displayToken()).toBeNull();
    expect(stored()).toEqual(before);
    // New address replaces it, and the new one is read from then on
    await persist.newDisplayToken();
    const made = await persist.displayToken();
    expect(made).toMatch(/^[\w-]{20,}$/);
    expect(await persist.displayToken()).toBe(made);
  });

  it("mints the display's address the first time only when none is saved", async () => {
    const { persist } = await fresh();
    const first = await persist.displayToken();
    expect(first).toMatch(/^[\w-]{20,}$/);
    expect(await (await fresh()).persist.displayToken()).toBe(first);
  });

  it("keeps the agents' token as stored when it can't be read, and says so to Settings", async () => {
    storeWith({ mcpToken: { enc: true, value: b64("bad:old-token") } });
    const before = stored();
    const { secrets, persist } = await fresh();
    await persist.ensureMcpToken();
    expect(stored()).toEqual(before);
    expect(await secrets.secretHint("mcpToken")).toEqual({
      saved: false,
      ends: null,
      unreadable: true,
    });
    await persist.newMcpToken();
    expect(await secrets.secretHint("mcpToken")).toMatchObject({ saved: true, unreadable: false });
  });
});

describe("a secrets file that can't be read", () => {
  const path = (): string => join(userData, "secrets.json");
  const b64 = (s: string): string => Buffer.from(s).toString("base64");

  /** Every secret unreadable, nothing minted, and no save over the file, whose bytes stay as found
   *  (New address and New token are the way out: "the way out of a secrets file" below). */
  const holdsAsFound = async (asFound: () => string): Promise<void> => {
    const before = asFound();
    const { secrets, persist } = await fresh();
    for (const name of ["lbToken", "mcpToken", "fanartKey", "displayToken"] as const) {
      expect(await secrets.readSecret(name)).toEqual({ state: "unreadable" });
      expect(secrets.hasSecret(name)).toBe(false);
      expect(await secrets.secretHint(name)).toEqual({
        saved: false,
        ends: null,
        unreadable: true,
      });
    }
    expect(await persist.displayToken()).toBeNull();
    await persist.ensureMcpToken();
    await expect(secrets.setSecret("lbToken", "lb-token-1234")).rejects.toThrow();
    await expect(secrets.setSecret("displayToken", "made-here-1234")).rejects.toThrow();
    await expect(secrets.setSecret("fanartKey", null)).rejects.toThrow();
    expect(await secrets.readSecret("lbToken")).toEqual({ state: "unreadable" });
    expect(asFound()).toBe(before);
  };

  it("counts only a missing file as one with nothing saved", async () => {
    const { secrets, persist } = await fresh();
    expect(await secrets.readSecret("displayToken")).toEqual({ state: "absent" });
    expect(await secrets.secretHint("lbToken")).toEqual({
      saved: false,
      ends: null,
      unreadable: false,
    });
    expect(await persist.displayToken()).toMatch(/^[\w-]{20,}$/);
  });

  it("keeps a file that isn't JSON as it is, and mints nothing over it", async () => {
    writeFileSync(path(), `{"v":1,"entries":{"displayToken":{"enc":true,"value":"${b64("enc:x")}"`);
    await holdsAsFound(() => file("secrets.json"));
  });

  it("keeps a file that isn't the store's as it is", async () => {
    for (const text of ["null", "[]", '"secrets"', '{"v":1}', '{"v":1,"entries":[]}']) {
      writeFileSync(path(), text);
      await holdsAsFound(() => file("secrets.json"));
    }
  });

  it("keeps a file that can't be opened, a folder in its place among them", async () => {
    mkdirSync(path());
    await holdsAsFound(() => (statSync(path()).isDirectory() ? "a folder" : "replaced"));
  });

  it("keeps a file its owner can't read as it is", async () => {
    // a filesystem without modes (Windows), or a test run as root, reads it anyway
    if (process.platform === "win32" || process.getuid?.() === 0) return;
    writeFileSync(
      path(),
      JSON.stringify({ v: 1, entries: { lbToken: { enc: false, value: "x" } } }),
    );
    chmodSync(path(), 0o000);
    try {
      await holdsAsFound(() => String(statSync(path()).mtimeMs));
    } finally {
      chmodSync(path(), 0o600);
    }
    expect(file("secrets.json")).toContain('"lbToken"');
  });

  it("reads a file an editor saved with a byte-order mark", async () => {
    writeFileSync(
      path(),
      `\uFEFF${JSON.stringify({ v: 1, entries: { lbToken: { enc: false, value: "lb-bom-1234" } } })}`,
    );
    expect(await (await fresh()).secrets.getSecret("lbToken")).toBe("lb-bom-1234");
  });

  it("leaves the old tokens in settings.json, and the launch goes on, when they can't be moved", async () => {
    writeFileSync(path(), "not json");
    writeFileSync(
      join(userData, "settings.json"),
      JSON.stringify({
        lbToken: "lb-secret-9876",
        mcp: { enabled: true, token: "mcp-secret-5432" },
      }),
    );
    const { persist } = await fresh();
    await expect(persist.moveSecrets()).resolves.toBeUndefined();
    persist.updateSettings({});
    expect(file("settings.json")).toContain("lb-secret-9876");
    expect(file("settings.json")).toContain("mcp-secret-5432");
    expect(file("secrets.json")).toBe("not json");
  });
});

describe("the way out of a secrets file that can't be read", () => {
  const path = (): string => join(userData, "secrets.json");
  const asides = (): string[] =>
    readdirSync(userData)
      .filter((f) => f.startsWith("secrets.unreadable-"))
      .sort();

  it("sets the file aside for New address, starts a new store with the address, and says so", async () => {
    const broken = `{"v":1,"entries":{"lbToken":{"enc":false,"value":"lb-1`;
    writeFileSync(path(), broken);
    // older copies set aside before: the newest three are kept, as for the other files
    for (const d of ["01", "02", "03"])
      writeFileSync(join(userData, `secrets.unreadable-2020-01-${d}T00-00-00.json`), "older");
    const { secrets, persist } = await fresh();
    expect(await persist.displayToken()).toBeNull();
    expect(await persist.newDisplayToken()).toBe(true);
    const kept = asides();
    expect(kept).toHaveLength(3);
    expect(kept).not.toContain("secrets.unreadable-2020-01-01T00-00-00.json");
    expect(readFileSync(join(userData, kept.at(-1)!), "utf8")).toBe(broken);
    // the new store holds the new address alone, and is saved to like any other from now on
    const made = await persist.displayToken();
    expect(made).toMatch(/^[\w-]{20,}$/);
    expect(Object.keys((JSON.parse(file("secrets.json")) as { entries: object }).entries)).toEqual([
      "displayToken",
    ]);
    expect(await secrets.readSecret("lbToken")).toEqual({ state: "absent" });
    await secrets.setSecret("lbToken", "lb-token-2222");
    expect(await (await fresh()).persist.displayToken()).toBe(made);
    // said once: the next New address is an ordinary one
    expect(await persist.newDisplayToken()).toBe(false);
    expect(await secrets.getSecret("lbToken")).toBe("lb-token-2222");
  });

  it("keeps a file that reads by the time New address is asked for, setting nothing aside", async () => {
    writeFileSync(path(), `{"v":1,"entries":{"lbToken":{"enc":false,"value":"lb-1`);
    const { secrets, persist } = await fresh();
    expect(await persist.displayToken()).toBeNull();
    // what kept it from being read has passed: the file is whole again
    writeFileSync(
      path(),
      JSON.stringify({ v: 1, entries: { lbToken: { enc: false, value: "lb-1" } } }),
    );
    expect(await persist.newDisplayToken()).toBe(false);
    expect(asides()).toHaveLength(0);
    expect(await secrets.getSecret("lbToken")).toBe("lb-1");
    expect(await persist.displayToken()).toMatch(/^[\w-]{20,}$/);
  });

  it("sets the file aside for New token the same way, a folder in its place among them", async () => {
    for (const make of [() => writeFileSync(path(), '{"v":1}'), () => mkdirSync(path())]) {
      userData = mkdtempSync(join(tmpdir(), "tt-secrets-"));
      make();
      const { secrets, persist } = await fresh();
      expect(await secrets.secretHint("mcpToken")).toMatchObject({ unreadable: true });
      expect(await persist.newMcpToken()).toBe(true);
      expect(asides()).toHaveLength(1);
      expect(await secrets.secretHint("mcpToken")).toMatchObject({
        saved: true,
        unreadable: false,
      });
      expect(statSync(path()).isFile()).toBe(true);
    }
  });

  it("keeps refusing, the file as found, when it can't be moved aside", async () => {
    // a filesystem without modes (Windows), or a test run as root, moves it anyway
    if (process.platform === "win32" || process.getuid?.() === 0) return;
    writeFileSync(path(), "not json");
    const { persist } = await fresh();
    chmodSync(userData, 0o500);
    try {
      await expect(persist.newDisplayToken()).rejects.toThrow();
      await expect(persist.newMcpToken()).rejects.toThrow();
    } finally {
      chmodSync(userData, 0o700);
    }
    expect(file("secrets.json")).toBe("not json");
    expect(asides()).toEqual([]);
    // and once it can be, the next New address is the way out
    expect(await persist.newDisplayToken()).toBe(true);
  });
});

describe("a save that can't be written", () => {
  it("leaves every secret as the file still has it", async () => {
    // a filesystem without modes (Windows), or a test run as root, writes it anyway
    if (process.platform === "win32" || process.getuid?.() === 0) return;
    const { secrets, persist } = await fresh();
    await secrets.setSecret("lbToken", "lb-token-1111");
    const address = await persist.displayToken();
    chmodSync(userData, 0o500);
    try {
      await expect(secrets.setSecret("lbToken", "lb-token-2222")).rejects.toThrow();
      await expect(secrets.setSecret("lbToken", null)).rejects.toThrow();
      await expect(secrets.setSecret("fanartKey", "fanart-3333")).rejects.toThrow();
      // a new address that couldn't be saved never ends the old one
      await expect(persist.newDisplayToken()).rejects.toThrow();
    } finally {
      chmodSync(userData, 0o700);
    }
    expect(await secrets.getSecret("lbToken")).toBe("lb-token-1111");
    expect(secrets.hasSecret("lbToken")).toBe(true);
    expect(await secrets.readSecret("fanartKey")).toEqual({ state: "absent" });
    expect(secrets.hasSecret("fanartKey")).toBe(false);
    expect(await persist.displayToken()).toBe(address);
    expect(await (await fresh()).secrets.getSecret("lbToken")).toBe("lb-token-1111");
  });

  it("makes no first address when its save fails, and makes one once it can", async () => {
    if (process.platform === "win32" || process.getuid?.() === 0) return;
    const { secrets, persist } = await fresh();
    chmodSync(userData, 0o500);
    try {
      await expect(persist.displayToken()).rejects.toThrow();
    } finally {
      chmodSync(userData, 0o700);
    }
    expect(await secrets.readSecret("displayToken")).toEqual({ state: "absent" });
    expect(await persist.displayToken()).toMatch(/^[\w-]{20,}$/);
  });
});

describe("a later version's secrets", () => {
  const read = (): { entries: Record<string, unknown> } & Record<string, unknown> =>
    JSON.parse(file("secrets.json")) as { entries: Record<string, unknown> } & Record<
      string,
      unknown
    >;

  it("keeps an entry of another shape as stored, reads it as unreadable and mints nothing over it", async () => {
    const sealed = { scheme: "sealed-2", box: "abcd" };
    const withNote = { enc: false, value: "fanart-1234", checkedAt: 99 };
    writeFileSync(
      join(userData, "secrets.json"),
      JSON.stringify({
        v: 1,
        written: "by a later version",
        entries: { displayToken: sealed, mcpToken: "a later form", fanartKey: withNote },
      }),
    );
    const { secrets, persist } = await fresh();
    for (const name of ["displayToken", "mcpToken"] as const) {
      expect(await secrets.readSecret(name)).toEqual({ state: "unreadable" });
      expect(secrets.hasSecret(name)).toBe(false);
      expect(await secrets.secretHint(name)).toEqual({
        saved: false,
        ends: null,
        unreadable: true,
      });
    }
    expect(await persist.displayToken()).toBeNull();
    await persist.ensureMcpToken();
    // the entry this version reads, a field it doesn't on it, reads as saved
    expect(await secrets.getSecret("fanartKey")).toBe("fanart-1234");
    // a change through the normal path writes every one of them back as found
    await secrets.setSecret("lbToken", "lb-token-5555");
    const after = read();
    expect(after.written).toBe("by a later version");
    expect(after.entries.displayToken).toEqual(sealed);
    expect(after.entries.mcpToken).toBe("a later form");
    expect(after.entries.fanartKey).toEqual(withNote);
    expect(
      Buffer.from((after.entries.lbToken as { value: string }).value, "base64").toString(),
    ).toBe(`enc:${[..."lb-token-5555"].reverse().join("")}`);
    // read again, still kept; New address replaces it, the deliberate way to a new one
    const again = await fresh();
    expect(await again.persist.displayToken()).toBeNull();
    expect(await again.persist.newDisplayToken()).toBe(false);
    expect(await again.persist.displayToken()).toMatch(/^[\w-]{20,}$/);
    expect(read().entries.mcpToken).toBe("a later form");
    expect(read().entries.displayToken).toMatchObject({ enc: true });
  });
});
