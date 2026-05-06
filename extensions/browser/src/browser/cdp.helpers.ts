/**
 * CDP helpers — standalone replacement (no openclaw deps).
 */
export function getHeadersWithAuth(
  _url: string,
  headers: Record<string, string> = {},
): Record<string, string> {
  // localhost CDP has no auth — just return headers as-is
  return headers;
}
