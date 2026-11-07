import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The secrets store over a stand-in safeStorage: "encryption" reverses the text and marks it, so
// a test can tell what reached the file; each test a fresh userData and fresh modules.
let userData = "";
let available = true;
// every call that could reach the keychain, counted (0.14.0: a launch that needs no secret
// touches none)
const touched = { available: 0, encrypt: 0, decrypt: 0 };
vi.mock("electron", () => ({
  app: { getPath: () => userData, getVersion: () => "0.0.0", isPackaged: false, on: () => {} },
  safeStorage: {
    isEncryptionAvailable: () => (touched.available++, available),
    getSelectedStorageBackend: () => "keychain",
    encryptString: (s: string) => (
      touched.encrypt++,
      Buffer.from(`enc:${[...s].reverse().join("")}`)
    ),
    decryptString: (b: Buffer) => (
      touched.decrypt++,
      [...b.toString().replace(/^enc:/, "")].reverse().join("")
    ),
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
    secrets.setSecret("lbToken", "  abcd-1234-wxyz  ");
    expect(file("secrets.json")).not.toContain("abcd-1234-wxyz");
    // owner-only on a filesystem with modes; Windows has none (DPAPI's encryption protects it)
    if (process.platform !== "win32")
      expect(statSync(join(userData, "secrets.json")).mode & 0o777).toBe(0o600);
    const again = (await fresh()).secrets;
    expect(again.getSecret("lbToken")).toBe("abcd-1234-wxyz");
    expect(again.secretHint("lbToken")).toEqual({ saved: true, ends: "wxyz" });
  });

  it("forgets a value set blank or null", async () => {
    const { secrets } = await fresh();
    secrets.setSecret("lbToken", "token-1");
    secrets.setSecret("lbToken", null);
    expect(secrets.getSecret("lbToken")).toBeNull();
    expect(secrets.secretHint("lbToken")).toEqual({ saved: false, ends: null });
  });

  it("keeps a value unencrypted where nothing can encrypt, and says so", async () => {
    available = false;
    const { secrets } = await fresh();
    expect(secrets.canEncrypt()).toBe(false);
    secrets.setSecret("mcpToken", "plain-token");
    expect(
      (JSON.parse(file("secrets.json")) as { entries: Record<string, unknown> }).entries.mcpToken,
    ).toEqual({
      enc: false,
      value: "plain-token",
    });
    process.env["TASTYTUNES_SECRETS_PLAIN"] = "1";
    available = true;
    expect((await fresh()).secrets.canEncrypt()).toBe(false);
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
    persist.moveSecrets();
    expect(secrets.getSecret("lbToken")).toBe("lb-secret-9876");
    expect(secrets.getSecret("mcpToken")).toBe("mcp-secret-5432");
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
    persist.moveSecrets();
    expect(secrets.getSecret("mcpToken")).toBeNull();
    persist.ensureMcpToken();
    const first = secrets.getSecret("mcpToken");
    expect(first).toMatch(/^[\w-]{20,}$/);
    persist.ensureMcpToken();
    expect(secrets.getSecret("mcpToken")).toBe(first);
    persist.newMcpToken();
    expect(secrets.getSecret("mcpToken")).not.toBe(first);
  });

  it("take a token an older build wrote since as the newer one, while the server is on", async () => {
    const { secrets, persist } = await fresh();
    persist.moveSecrets();
    // the installed 0.12.0 finds no token and mints its own into settings.json
    writeFileSync(
      join(userData, "settings.json"),
      JSON.stringify({ mcp: { enabled: true, token: "minted-by-0.12" } }),
    );
    const later = await fresh();
    later.persist.moveSecrets();
    expect(later.secrets.getSecret("mcpToken")).toBe("minted-by-0.12");
    expect(file("settings.json")).not.toContain("minted-by-0.12");
    void secrets;
  });

  it("drop the token 0.12.0 minted for an install that never turned the server on", async () => {
    writeFileSync(
      join(userData, "settings.json"),
      JSON.stringify({ mcp: { enabled: false, token: "minted-by-0.12" } }),
    );
    const { secrets, persist } = await fresh();
    persist.moveSecrets();
    expect(secrets.getSecret("mcpToken")).toBeNull();
    expect(file("settings.json")).not.toContain("minted-by-0.12");
    expect(keychainUse()).toBe(0);
  });
});

describe("the keychain only when a secret is used", () => {
  it("a launch with no secrets never reaches it, Settings' hints included", async () => {
    writeFileSync(join(userData, "settings.json"), JSON.stringify({ mcp: { enabled: false } }));
    const { secrets, persist } = await fresh();
    persist.moveSecrets();
    expect(secrets.secretHint("lbToken")).toEqual({ saved: false, ends: null });
    expect(secrets.secretHint("mcpToken")).toEqual({ saved: false, ends: null });
    expect(secrets.getSecret("fanartKey")).toBeNull();
    // where the platform's keychain is always there it is never asked; Linux asks for a keyring
    expect(secrets.encryptsHere()).toBe(true);
    if (process.platform === "darwin" || process.platform === "win32")
      expect(keychainUse()).toBe(0);
    else expect(touched.encrypt + touched.decrypt).toBe(0);
  });

  it("decrypts an entry only when it is asked for, and a save leaves the others as stored", async () => {
    const first = await fresh();
    first.secrets.setSecret("lbToken", "lb-token-1111");
    first.secrets.setSecret("fanartKey", "fanart-2222");
    const before = JSON.parse(file("secrets.json")) as { entries: Record<string, unknown> };
    touched.available = touched.encrypt = touched.decrypt = 0;
    const { secrets } = await fresh();
    expect(secrets.hasSecret("lbToken")).toBe(true);
    expect(touched.decrypt).toBe(0);
    expect(secrets.secretHint("fanartKey")).toEqual({ saved: true, ends: "2222" });
    expect(touched.decrypt).toBe(1);
    secrets.setSecret("mcpToken", "mcp-3333");
    expect(touched.decrypt).toBe(1);
    const after = JSON.parse(file("secrets.json")) as { entries: Record<string, unknown> };
    expect(after.entries.lbToken).toEqual(before.entries.lbToken);
    expect((await fresh()).secrets.getSecret("lbToken")).toBe("lb-token-1111");
  });

  it("says unencrypted where the saved values are, without asking the keychain", async () => {
    available = false;
    (await fresh()).secrets.setSecret("lbToken", "plain-1");
    available = true;
    touched.available = 0;
    expect((await fresh()).secrets.encryptsHere()).toBe(false);
    expect(touched.available).toBe(0);
  });
});
