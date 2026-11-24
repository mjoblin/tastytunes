import { describe, expect, it } from "vitest";
import { qrModules, qrPath } from "./QrCode";
import { maskedAddress } from "@/lib/displayAddress";

describe("the display address's QR code", () => {
  it("encodes the whole address as a square code with its three finder patterns", () => {
    const url = "http://192.168.1.20:8556/?t=Zk3pQ9vX2mLr8sT4wY6uB1nC5dE7fG0h";
    const m = qrModules(url);
    const n = m.length;
    expect(n).toBeGreaterThanOrEqual(29);
    expect(m.every((row) => row.length === n)).toBe(true);
    // a finder's outer ring: seven dark modules along its top and left
    for (const [r0, c0] of [
      [0, 0],
      [0, n - 7],
      [n - 7, 0],
    ])
      for (let i = 0; i < 7; i++) {
        expect(m[r0][c0 + i]).toBe(true);
        expect(m[r0 + i][c0]).toBe(true);
      }
    // a longer address makes a code at least as large
    expect(qrModules(`${url}&x=${"a".repeat(40)}`).length).toBeGreaterThanOrEqual(n);
  });

  it("draws one unit square per dark module, inside the quiet zone", () => {
    const path = qrPath(
      [
        [true, false],
        [false, true],
      ],
      4,
    );
    expect(path).toBe("M4 4h1v1h-1zM5 5h1v1h-1z");
  });

  it("shows the address with its token masked to the last four", () => {
    expect(maskedAddress("http://192.168.1.20:8556/?t=Zk3pQ9vX2mLr8sT4wY6uB1nC5dE7fG0h")).toBe(
      "http://192.168.1.20:8556/?t=••••••••fG0h",
    );
  });
});
