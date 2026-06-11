import { Errors } from './errors.js';

export interface HttpClientOptions {
  timeoutMs?: number;
  headers?: Record<string, string>;
}

export const httpGetJson = async <T>(url: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<T> => {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), init.timeoutMs ?? 10000);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    if (res.status === 401) throw Errors.authFailed();
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json() as T;
  } catch (e: any) {
    if (e.name === 'AbortError') throw Errors.timeout();
    throw e;
  } finally {
    clearTimeout(t);
  }
};

export const httpGetText = async (url: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<string> => {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), init.timeoutMs ?? 10000);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    if (res.status === 401) throw Errors.authFailed();
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } catch (e: any) {
    if (e.name === 'AbortError') throw Errors.timeout();
    throw e;
  } finally {
    clearTimeout(t);
  }
};

export const httpPost = async (url: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<{ status: number; headers: Record<string, string | null> }> => {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), init.timeoutMs ?? 10000);
  try {
    const res = await fetch(url, { method: 'POST', ...init, signal: controller.signal });
    if (res.status === 401) throw Errors.authFailed();
    // Throw on 4xx/5xx so callers don't have to remember to check `res.status`.
    // The previous lax behavior led to silent successes in `updateJobConfig`,
    // `triggerBuild`, `stopBuild`, `deleteBuild`, `enableJob`, `disableJob`,
    // `deleteJob`, `cancelQueueItem`, `toggleNodeOffline`, `quietDown`,
    // `cancelQuietDown`, and `safeRestart` — all of which used to return
    // success even when Jenkins rejected the request. The error message
    // includes the URL and a body snippet for debuggability, but preserves
    // the `HTTP <code>` substring that the existing `try/catch` blocks
    // (and tests) match on.
    if (res.status >= 400) {
      // Drain the body so the connection can be reused for the next request,
      // then throw with a structured error. We check `>= 400` rather than
      // `!res.ok` because 3xx redirects (notably 302, which `moveJob` and
      // `restoreJobConfigVersion` treat as success) are also `!ok` per the
      // Fetch spec — 3xx must keep returning so those callers can inspect
      // headers and status.
      let detail = "";
      try { detail = (await res.text()).slice(0, 500); } catch { /* ignore */ }
      throw new Error(`HTTP ${res.status} on POST ${url}: ${detail}`);
    }
    return { status: res.status, headers: Object.fromEntries(res.headers.entries()) };
  } catch (e: any) {
    if (e.name === 'AbortError') throw Errors.timeout();
    throw e;
  } finally { clearTimeout(t); }
};

export const httpGetBuffer = async (url: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<Buffer> => {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), init.timeoutMs ?? 10000);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    if (res.status === 401) throw Errors.authFailed();
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const ab = await res.arrayBuffer();
    return Buffer.from(ab);
  } catch (e: any) {
    if (e.name === 'AbortError') throw Errors.timeout();
    throw e;
  } finally { clearTimeout(t); }
};
