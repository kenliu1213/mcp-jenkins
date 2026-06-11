import { describe, it, expect, vi, afterEach, beforeEach } from "vitest"
import { httpGetJson, httpGetText, httpPost } from "../../src/common/http.js"

const mockFetchResponse = (init: {
  status: number
  body?: string
  headers?: Record<string, string>
}) =>
  ({
    status: init.status,
    ok: init.status >= 200 && init.status < 300,
    headers: {
      entries: () => Object.entries(init.headers ?? {}),
      get: (k: string) => (init.headers ?? {})[k] ?? null,
    },
    text: () => Promise.resolve(init.body ?? ""),
    json: () => Promise.resolve(JSON.parse(init.body ?? "null")),
  }) as unknown as Response

describe("httpPost", () => {
  let originalFetch: typeof fetch
  beforeEach(() => {
    originalFetch = globalThis.fetch
  })
  afterEach(() => {
    globalThis.fetch = originalFetch
    vi.useRealTimers()
  })

  it("returns status and headers on 2xx", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      mockFetchResponse({ status: 200, headers: { location: "/q/123" } }),
    )
    const res = await httpPost("https://example.com/x", { headers: { a: "1" } })
    expect(res.status).toBe(200)
    expect(res.headers["location"]).toBe("/q/123")
  })

  it("returns 201 status without throwing (used for triggerBuild queue URL)", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      mockFetchResponse({ status: 201, headers: { location: "/q/456" } }),
    )
    const res = await httpPost("https://example.com/build")
    expect(res.status).toBe(201)
    expect(res.headers["location"]).toBe("/q/456")
  })

  it("returns 302 status without throwing (used for moveJob/restoreJobConfigVersion)", async () => {
    // 3xx is not 4xx/5xx — the helper should let the caller decide. moveJob
    // and restoreJobConfigVersion treat 302 as "accepted, follow the
    // Location header" and inspect headers, so we must not throw here.
    globalThis.fetch = vi.fn().mockResolvedValue(
      mockFetchResponse({ status: 302, headers: { location: "/job/new" } }),
    )
    const res = await httpPost("https://example.com/move")
    expect(res.status).toBe(302)
    expect(res.headers["location"]).toBe("/job/new")
  })

  it("throws on 404 with the URL in the message", async () => {
    // Simulate Jenkins returning a short error body in the 4xx response.
    globalThis.fetch = vi.fn().mockResolvedValue(
      mockFetchResponse({ status: 404, body: "Not found" }),
    )
    await expect(httpPost("https://example.com/missing")).rejects.toThrow(
      /HTTP 404 on POST https:\/\/example.com\/missing/,
    )
  })

  it("preserves the `HTTP <code>` substring in the error message", async () => {
    // Callers and tests match on `e.message?.includes("HTTP 404")` — this
    // must keep working even with the new URL+body detail appended.
    globalThis.fetch = vi.fn().mockResolvedValue(
      mockFetchResponse({ status: 404, body: "Not found" }),
    )
    await expect(httpPost("https://example.com/x")).rejects.toThrow(
      /HTTP 404/,
    )
  })

  it("throws on 5xx", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(mockFetchResponse({ status: 500, body: "oops" }))
    await expect(httpPost("https://example.com/x")).rejects.toThrow(/HTTP 500/)
  })

  it("throws authFailed on 401", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(mockFetchResponse({ status: 401 }))
    await expect(httpPost("https://example.com/x")).rejects.toMatchObject({
      code: "AUTH_FAILED",
    })
  })

  it("truncates the error body to 500 chars", async () => {
    const huge = "x".repeat(2000)
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(mockFetchResponse({ status: 500, body: huge }))
    await expect(httpPost("https://example.com/x")).rejects.toThrow(
      /x{500}/,
    )
  })

  it("throws timeout on AbortError", async () => {
    globalThis.fetch = vi.fn().mockImplementation(() => {
      const err: any = new Error("aborted")
      err.name = "AbortError"
      return Promise.reject(err)
    })
    await expect(
      httpPost("https://example.com/x", { timeoutMs: 50 }),
    ).rejects.toMatchObject({ code: "TIMEOUT" })
  })
})

describe("httpGetJson / httpGetText", () => {
  let originalFetch: typeof fetch
  beforeEach(() => {
    originalFetch = globalThis.fetch
  })
  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it("httpGetJson throws on 4xx (regression for the update_job_config 4xx bug)", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(mockFetchResponse({ status: 400, body: "bad" }))
    await expect(httpGetJson("https://example.com/x")).rejects.toThrow(
      /HTTP 400/,
    )
  })

  it("httpGetText throws on 4xx", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(mockFetchResponse({ status: 403, body: "no" }))
    await expect(httpGetText("https://example.com/x")).rejects.toThrow(
      /HTTP 403/,
    )
  })
})
