/** The address with its token masked to the last four: the address is the secret, and Settings
 *  can end up in a screenshot or a shared screen (Copy and the QR code carry it whole). */
export function maskedAddress(url: string): string {
  return url.replace(/([?&]t=)([^&]*)/, (_m, key: string, token: string) => {
    const plain = decodeURIComponent(token);
    return `${key}••••••••${plain.slice(-4)}`;
  });
}
