import { useMemo } from "react";
import qrcode from "qrcode-generator";

/** The square modules of a QR code for `text`, row by row (true = dark), with no quiet zone. */
export function qrModules(text: string): boolean[][] {
  // type 0 picks the smallest code that holds the text; M survives a little glare on a screen
  const qr = qrcode(0, "M");
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount();
  return Array.from({ length: n }, (_, r) => Array.from({ length: n }, (_, c) => qr.isDark(r, c)));
}

/** The dark modules as one SVG path, a unit square each, offset by the quiet zone. */
export function qrPath(modules: boolean[][], quiet: number): string {
  const parts: string[] = [];
  modules.forEach((row, r) =>
    row.forEach((dark, c) => {
      if (dark) parts.push(`M${c + quiet} ${r + quiet}h1v1h-1z`);
    }),
  );
  return parts.join("");
}

/**
 * A QR CODE, MADE HERE (Display on other screens' address, Settings › Integrations): encoded by
 * qrcode-generator in the window, nothing sent anywhere, drawn as one SVG path. Always dark on
 * white with the standard four-module quiet zone, whatever the theme: a phone's camera reads
 * that, and a light-on-dark code many don't.
 */
export function QrCode({
  text,
  size = 168,
  label,
}: {
  text: string;
  size?: number;
  label: string;
}): React.JSX.Element {
  const quiet = 4;
  const modules = useMemo(() => qrModules(text), [text]);
  const side = modules.length + quiet * 2;
  return (
    <svg
      data-qr-code
      role="img"
      aria-label={label}
      width={size}
      height={size}
      viewBox={`0 0 ${side} ${side}`}
      shapeRendering="crispEdges"
      className="rounded-md ring-1 ring-edge"
    >
      <rect width={side} height={side} fill="white" />
      <path d={qrPath(modules, quiet)} fill="black" />
    </svg>
  );
}
