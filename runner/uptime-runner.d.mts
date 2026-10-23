export interface Check {
  id: string;
  name?: string;
  type: "http" | "tcp" | "dns" | "tls";
  target: string;
  expect?: { status?: number; text?: string; recordType?: string; record?: string; minDays?: number };
}
export interface Outcome {
  ok: boolean;
  latencyMs: number;
  detail: string;
}
export interface Options {
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  resolver?: { resolve(host: string, type: string): Promise<unknown[]> };
  now?: () => number;
}
export function runHttp(check: Check, options?: Options): Promise<Outcome>;
export function runTcp(check: Check, options?: Options): Promise<Outcome>;
export function runDns(check: Check, options?: Options): Promise<Outcome>;
export function runTls(check: Check, options?: Options): Promise<Outcome>;
export function runCheck(check: Check, options?: Options): Promise<Outcome>;
export function runAll(
  checks: Check[],
  location: string | undefined,
  options?: Options,
): Promise<Array<Outcome & { checkId: string; time: string; location?: string }>>;
export function daysUntil(validTo: string, now?: number): number;
export function main(env?: Record<string, string | undefined>, io?: { fetchImpl?: typeof fetch; log?: (message: string) => void }): Promise<void>;
