const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/**
 * Last line of defence on every guest-facing response. Handlers should never
 * build a body containing an upstream identifier; if one ever does, this turns
 * a deanonymization into a 500.
 */
export function containsUpstreamIdentifier(body: string): boolean {
  return UUID_RE.test(body);
}

/** Headers stripped from anything we proxy or generate. */
export const STRIPPED_HEADERS = ["server", "via", "x-powered-by"];
