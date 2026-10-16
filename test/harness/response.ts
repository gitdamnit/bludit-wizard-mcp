/**
 * Shared shapes for the test harness.
 *
 * The host's `fetch` (undici) and workerd's `Response` are structurally
 * compatible for what the harness needs, but not nominally identical — workerd's
 * `Response` carries a `cf` property. Typing against this minimal interface lets
 * one helper accept responses from either side without casts.
 */

export interface AnyResponse {
  ok: boolean;
  status: number;
  headers: {
    get(name: string): string | null;
    getSetCookie?(): string[];
  };
  text(): Promise<string>;
  json(): Promise<unknown>;
}
