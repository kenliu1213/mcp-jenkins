import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { JenkinsClient } from "../../src/lib/jenkins-client.js"
import * as common from "../../src/common/index.js"

const mockFetchResponse = (body: unknown, setCookie?: string) =>
  Promise.resolve({
    ok: true,
    status: 200,
    headers: {
      get: (h: string) => (h === "set-cookie" ? (setCookie ?? null) : null),
      getSetCookie: () => (setCookie ? [setCookie] : []),
    },
    json: () => Promise.resolve(body),
  } as unknown as Response)

vi.mock(import("../../src/common/index.js"), async (importOriginal) => {
  const actual = await importOriginal()
  class McpError extends Error {
    code: string
    status?: number
    constructor(code: string, message: string, status?: number) {
      super(message)
      this.code = code
      this.status = status
    }
  }
  return {
    ...actual,
    httpGetJson: vi.fn(),
    httpGetText: vi.fn(),
    httpPost: vi.fn(),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    loadJenkinsEnv: vi.fn(() => ({
      JENKINS_URL: "https://jenkins.example.com",
      JENKINS_USER: "testuser",
      JENKINS_API_TOKEN: "testtoken",
    })),
    McpError,
    Errors: {
      authFailed: () => new Error("Authentication failed"),
      jobNotFound: (job: string) => new Error(`Job not found: ${job}`),
      artifactNotFound: (path: string) =>
        new Error(`Artifact not found: ${path}`),
      destinationConflict: (dest: string) =>
        new Error(`Job already exists at destination: ${dest}`),
      unexpected: (msg: string) => new Error(msg),
    },
  }
})

describe("JenkinsClient", () => {
  let client: JenkinsClient

  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal("fetch", vi.fn())
    client = new JenkinsClient()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  describe("constructor", () => {
    it("should use environment variables when no credentials provided", () => {
      const client = new JenkinsClient()
      expect(common.loadJenkinsEnv).toHaveBeenCalled()
    })

    it("should use provided credentials over environment", () => {
      const creds = {
        baseUrl: "https://custom.jenkins.com",
        authHeader: "Bearer custom-token",
      }
      const client = new JenkinsClient(creds)
      // Client should not load env when credentials are provided
      expect(client).toBeDefined()
    })
  })

  describe("listJobs", () => {
    it("should return list of jobs", async () => {
      const mockResponse = {
        jobs: [
          { name: "job-1", url: "https://jenkins.example.com/job/job-1" },
          { name: "job-2", url: "https://jenkins.example.com/job/job-2" },
        ],
      }
      vi.mocked(common.httpGetJson).mockResolvedValue(mockResponse)

      const jobs = await client.listJobs()

      expect(jobs).toEqual([
        { name: "job-1", url: "https://jenkins.example.com/job/job-1" },
        { name: "job-2", url: "https://jenkins.example.com/job/job-2" },
      ])
      expect(common.httpGetJson).toHaveBeenCalledWith(
        "https://jenkins.example.com/api/json",
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: expect.any(String),
          }),
        }),
      )
    })

    it("should return empty array when no jobs", async () => {
      vi.mocked(common.httpGetJson).mockResolvedValue({ jobs: null })

      const jobs = await client.listJobs()

      expect(jobs).toEqual([])
    })

    it("should throw auth error on 401", async () => {
      vi.mocked(common.httpGetJson).mockRejectedValue(new Error("HTTP 401"))

      await expect(client.listJobs()).rejects.toThrow("Authentication failed")
    })
  })

  describe("getRecentBuilds", () => {
    it("should return recent builds with normalized data", async () => {
      const mockResponse = {
        builds: [
          {
            number: 100,
            result: "SUCCESS",
            duration: 5000,
            timestamp: 1698768000000,
            url: "https://jenkins.example.com/job/test-job/100/",
            building: false,
          },
          {
            number: 99,
            result: "FAILURE",
            duration: 3000,
            timestamp: 1698764400000,
            url: "https://jenkins.example.com/job/test-job/99/",
            building: false,
          },
        ],
      }
      vi.mocked(common.httpGetJson).mockResolvedValue(mockResponse)

      const builds = await client.getRecentBuilds("test-job", 2)

      expect(builds).toHaveLength(2)
      expect(builds[0]).toMatchObject({
        id: "100",
        result: "SUCCESS",
        durationMs: 5000,
      })
      expect(builds[1]).toMatchObject({
        id: "99",
        result: "FAILURE",
        durationMs: 3000,
      })
    })

    it("should mark building jobs as RUNNING", async () => {
      const mockResponse = {
        builds: [
          {
            number: 101,
            building: true,
            duration: 0,
            timestamp: Date.now(),
            url: "https://jenkins.example.com/job/test-job/101/",
          },
        ],
      }
      vi.mocked(common.httpGetJson).mockResolvedValue(mockResponse)

      const builds = await client.getRecentBuilds("test-job", 1)

      expect(builds[0].result).toBe("RUNNING")
    })

    it("should throw job not found error on 404", async () => {
      vi.mocked(common.httpGetJson).mockRejectedValue(new Error("HTTP 404"))

      await expect(client.getRecentBuilds("nonexistent-job")).rejects.toThrow(
        "Job not found: nonexistent-job",
      )
    })
  })

  describe("getLastBuild", () => {
    it("should return last build normalized", async () => {
      const mockResponse = {
        number: 42,
        result: "SUCCESS",
        duration: 10000,
        timestamp: 1698768000000,
        url: "https://jenkins.example.com/job/my-job/42/",
        building: false,
      }
      vi.mocked(common.httpGetJson).mockResolvedValue(mockResponse)

      const build = await client.getLastBuild("my-job")

      expect(build).toMatchObject({
        id: "42",
        result: "SUCCESS",
        durationMs: 10000,
      })
    })
  })

  describe("getBuild", () => {
    it("should return specific build", async () => {
      const mockResponse = {
        number: 55,
        result: "ABORTED",
        duration: 2000,
        timestamp: 1698768000000,
        url: "https://jenkins.example.com/job/my-job/55/",
        building: false,
      }
      vi.mocked(common.httpGetJson).mockResolvedValue(mockResponse)

      const build = await client.getBuild("my-job", 55)

      expect(build.id).toBe("55")
      expect(build.result).toBe("ABORTED")
    })
  })

  describe("getConsoleLog", () => {
    it("should return console log with snippet", async () => {
      const fullLog = "Line 1\nLine 2\nLine 3\nLine 4\n".repeat(10)
      vi.mocked(common.httpGetText).mockResolvedValue(fullLog)
      vi.mocked(common.httpGetJson).mockResolvedValue({
        number: 10,
        building: false,
      })

      const result = await client.getConsoleLog("my-job", 10, 50)

      expect(result.jobName).toBe("my-job")
      expect(result.buildNumber).toBe(10)
      expect(result.logSnippet).toHaveLength(50)
      expect(result.fullLog).toBe(fullLog)
    })

    it("should fetch last build when buildNumber not provided", async () => {
      const fullLog = "Console output"
      vi.mocked(common.httpGetJson).mockResolvedValue({
        number: 15,
        building: false,
      })
      vi.mocked(common.httpGetText).mockResolvedValue(fullLog)

      const result = await client.getConsoleLog("my-job")

      expect(result.buildNumber).toBe(15)
    })
  })

  describe("triggerBuild", () => {
    it("should trigger build without parameters", async () => {
      const mockCrumb = { crumbRequestField: "Jenkins-Crumb", crumb: "abc123" }
      vi.mocked(fetch).mockReturnValue(mockFetchResponse(mockCrumb))
      vi.mocked(common.httpPost).mockResolvedValue({
        headers: { location: "https://jenkins.example.com/queue/item/123/" },
      })

      const result = await client.triggerBuild("my-job")

      expect(result.jobName).toBe("my-job")
      expect(result.queueUrl).toBe(
        "https://jenkins.example.com/queue/item/123/",
      )
      expect(common.httpPost).toHaveBeenCalledWith(
        "https://jenkins.example.com/job/my-job/build",
        expect.objectContaining({
          headers: expect.objectContaining({
            "Jenkins-Crumb": "abc123",
          }),
        }),
      )
    })

    it("should trigger build with parameters", async () => {
      const mockCrumb = { crumbRequestField: "Jenkins-Crumb", crumb: "xyz789" }
      vi.mocked(fetch).mockReturnValue(mockFetchResponse(mockCrumb))
      vi.mocked(common.httpPost).mockResolvedValue({
        headers: { location: "https://jenkins.example.com/queue/item/456/" },
      })

      const result = await client.triggerBuild("my-job", {
        branch: "main",
        tag: "v1.0",
      })

      expect(common.httpPost).toHaveBeenCalledWith(
        "https://jenkins.example.com/job/my-job/buildWithParameters",
        expect.objectContaining({
          headers: expect.objectContaining({
            "Content-Type": "application/x-www-form-urlencoded",
          }),
          body: expect.stringContaining("branch=main"),
        }),
      )
    })

    it("captures Set-Cookie from crumb fetch and injects Cookie on POST", async () => {
      const mockCrumb = {
        crumbRequestField: "Jenkins-Crumb",
        crumb: "cookie123",
      }
      vi.mocked(fetch).mockReturnValue(
        mockFetchResponse(mockCrumb, "JSESSIONID=abc123; Path=/"),
      )
      vi.mocked(common.httpPost).mockResolvedValue({
        status: 201,
        headers: { location: "/queue/1" },
      })

      await client.triggerBuild("my-job")

      expect(common.httpPost).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: expect.objectContaining({
            Cookie: "JSESSIONID=abc123",
          }),
        }),
      )
    })
  })

  describe("listArtifacts", () => {
    it("should list build artifacts", async () => {
      const mockResponse = {
        artifacts: [
          { fileName: "app.jar", relativePath: "build/app.jar" },
          {
            fileName: "test-results.xml",
            relativePath: "build/test-results.xml",
          },
        ],
      }
      vi.mocked(common.httpGetJson).mockResolvedValue(mockResponse)

      const artifacts = await client.listArtifacts("my-job", 100)

      expect(artifacts).toHaveLength(2)
      expect(artifacts[0]).toMatchObject({
        fileName: "app.jar",
        relativePath: "build/app.jar",
        url: expect.stringContaining("artifact/build/app.jar"),
      })
    })

    it("should return empty array when no artifacts", async () => {
      vi.mocked(common.httpGetJson).mockResolvedValue({ artifacts: null })

      const artifacts = await client.listArtifacts("my-job", 100)

      expect(artifacts).toEqual([])
    })
  })

  describe("searchJobs", () => {
    it("should filter jobs by query", async () => {
      const mockResponse = {
        jobs: [
          { name: "frontend-build", url: "url1" },
          { name: "backend-build", url: "url2" },
          { name: "frontend-test", url: "url3" },
        ],
      }
      vi.mocked(common.httpGetJson).mockResolvedValue(mockResponse)

      const results = await client.searchJobs("frontend")

      expect(results).toHaveLength(2)
      expect(results.map((j) => j.name)).toEqual([
        "frontend-build",
        "frontend-test",
      ])
    })

    it("should return empty array for empty query", async () => {
      const results = await client.searchJobs("   ")

      expect(results).toEqual([])
    })
  })

  describe("stopBuild", () => {
    it("should stop a running build", async () => {
      const mockCrumb = { crumbRequestField: "Jenkins-Crumb", crumb: "stop123" }
      vi.mocked(fetch).mockReturnValue(mockFetchResponse(mockCrumb))
      vi.mocked(common.httpPost).mockResolvedValue({ headers: {} })

      const result = await client.stopBuild("my-job", 50)

      expect(result).toEqual({
        jobName: "my-job",
        buildNumber: 50,
        stopped: true,
      })
      expect(common.httpPost).toHaveBeenCalledWith(
        "https://jenkins.example.com/job/my-job/50/stop",
        expect.anything(),
      )
    })
  })

  describe("getTestResults", () => {
    it("should return test results", async () => {
      const mockResponse = {
        totalCount: 100,
        passCount: 95,
        failCount: 3,
        skipCount: 2,
        duration: 45.5,
        suites: [{ name: "Suite1" }],
      }
      vi.mocked(common.httpGetJson).mockResolvedValue(mockResponse)

      const result = await client.getTestResults("my-job", 10)

      expect(result.totalTests).toBe(100)
      expect(result.passedTests).toBe(95)
      expect(result.failedTests).toBe(3)
      expect(result.skippedTests).toBe(2)
    })

    it("should handle missing test results", async () => {
      vi.mocked(common.httpGetJson).mockRejectedValue(new Error("HTTP 404"))

      const result = await client.getTestResults("my-job", 10)

      expect(result.message).toContain("No test results found")
      expect(result.totalTests).toBe(0)
    })
  })

  describe("getQueue", () => {
    it("should return build queue", async () => {
      const mockResponse = {
        items: [
          {
            id: 123,
            blocked: false,
            buildable: true,
            stuck: false,
            why: "Waiting for executor",
            task: { name: "my-job", url: "url1" },
            inQueueSince: 1698768000000,
          },
        ],
      }
      vi.mocked(common.httpGetJson).mockResolvedValue(mockResponse)

      const queue = await client.getQueue()

      expect(queue).toHaveLength(1)
      expect(queue[0].id).toBe(123)
      expect(queue[0].why).toBe("Waiting for executor")
    })
  })

  describe("getSystemInfo", () => {
    it("should return Jenkins system info", async () => {
      const mockResponse = {
        nodeDescription: "Jenkins Controller",
        nodeName: "master",
        numExecutors: 4,
        mode: "NORMAL",
        quietingDown: false,
        useCrumbs: true,
        useSecurity: true,
      }
      vi.mocked(common.httpGetJson).mockResolvedValue(mockResponse)

      const info = await client.getSystemInfo()

      expect(info.nodeDescription).toBe("Jenkins Controller")
      expect(info.numExecutors).toBe(4)
      expect(info.useSecurity).toBe(true)
    })
  })

  describe("createJob", () => {
    it("should create a job with XML config", async () => {
      const mockCrumb = { crumbRequestField: "Jenkins-Crumb", crumb: "crumb1" }
      vi.mocked(fetch).mockReturnValue(mockFetchResponse(mockCrumb))
      vi.mocked(common.httpPost).mockResolvedValue({ status: 200, headers: {} })

      const result = await client.createJob("new-job", "<project/>")

      expect(result).toEqual({ jobName: "new-job", created: true })
      expect(common.httpPost).toHaveBeenCalledWith(
        "https://jenkins.example.com/createItem?name=new-job",
        expect.objectContaining({
          headers: expect.objectContaining({
            "Content-Type": "application/xml",
          }),
          body: "<project/>",
        }),
      )
    })

    it("should throw on HTTP 4xx response", async () => {
      const mockCrumb = { crumbRequestField: "Jenkins-Crumb", crumb: "crumb1" }
      vi.mocked(fetch).mockReturnValue(mockFetchResponse(mockCrumb))
      vi.mocked(common.httpPost).mockResolvedValue({ status: 400, headers: {} })

      await expect(client.createJob("bad-job", "<bad/>")).rejects.toThrow(
        "Create job failed",
      )
    })
  })

  describe("updateJobConfig", () => {
    it("should update job config", async () => {
      const mockCrumb = { crumbRequestField: "Jenkins-Crumb", crumb: "crumb2" }
      vi.mocked(fetch).mockReturnValue(mockFetchResponse(mockCrumb))
      vi.mocked(common.httpPost).mockResolvedValue({ status: 200, headers: {} })

      const result = await client.updateJobConfig("my-job", "<project/>")

      expect(result).toEqual({ jobName: "my-job", updated: true })
      expect(common.httpPost).toHaveBeenCalledWith(
        "https://jenkins.example.com/job/my-job/config.xml",
        expect.objectContaining({ body: "<project/>" }),
      )
    })

    it("should throw jobNotFound when Jenkins returns 404", async () => {
      const mockCrumb = { crumbRequestField: "Jenkins-Crumb", crumb: "crumb2" }
      vi.mocked(fetch).mockReturnValue(mockFetchResponse(mockCrumb))
      vi.mocked(common.httpPost).mockResolvedValue({ status: 404, headers: {} })

      await expect(
        client.updateJobConfig("missing-job", "<project/>"),
      ).rejects.toThrow("Job not found: missing-job")
    })

    it("should throw when Jenkins rejects the XML with 5xx", async () => {
      // Regression: previously httpPost's return was discarded, so any non-401
      // response was treated as success — including 5xx from XML validation
      // failures. The tool would return { updated: true } while the change
      // never took effect.
      const mockCrumb = { crumbRequestField: "Jenkins-Crumb", crumb: "crumb2" }
      vi.mocked(fetch).mockReturnValue(mockFetchResponse(mockCrumb))
      vi.mocked(common.httpPost).mockResolvedValue({ status: 500, headers: {} })

      await expect(
        client.updateJobConfig("my-job", "<malformed/>"),
      ).rejects.toThrow(/Update job config failed: HTTP 500/)
    })
  })

  describe("renameJob", () => {
    it("should rename a job", async () => {
      const mockCrumb = { crumbRequestField: "Jenkins-Crumb", crumb: "crumb3" }
      vi.mocked(fetch).mockReturnValue(mockFetchResponse(mockCrumb))
      vi.mocked(common.httpPost).mockResolvedValue({ status: 200, headers: {} })

      const result = await client.renameJob("old-name", "new-name")

      expect(result).toEqual({
        oldName: "old-name",
        newName: "new-name",
        renamed: true,
      })
      // Regression: /rename is the form-page URL (GET only) and 404s on POST.
      // The action handler is /doRename.
      expect(common.httpPost).toHaveBeenCalledWith(
        "https://jenkins.example.com/job/old-name/doRename?newName=new-name",
        expect.anything(),
      )
    })

    it("should throw jobNotFound when Jenkins returns 404", async () => {
      const mockCrumb = { crumbRequestField: "Jenkins-Crumb", crumb: "crumb3" }
      vi.mocked(fetch).mockReturnValue(mockFetchResponse(mockCrumb))
      vi.mocked(common.httpPost).mockResolvedValue({ status: 404, headers: {} })

      await expect(
        client.renameJob("missing-job", "new-name"),
      ).rejects.toThrow("Job not found: missing-job")
    })

    it("should throw when Jenkins rejects the rename with 4xx/5xx", async () => {
      // Regression: response status used to be ignored, so /rename 404s and
      // /doRename validation failures both reported { renamed: true }.
      const mockCrumb = { crumbRequestField: "Jenkins-Crumb", crumb: "crumb3" }
      vi.mocked(fetch).mockReturnValue(mockFetchResponse(mockCrumb))
      vi.mocked(common.httpPost).mockResolvedValue({ status: 500, headers: {} })

      await expect(
        client.renameJob("old-name", "new-name"),
      ).rejects.toThrow(/Rename job failed: HTTP 500/)
    })
  })

  describe("copyJob", () => {
    it("should copy a job", async () => {
      const mockCrumb = { crumbRequestField: "Jenkins-Crumb", crumb: "crumb4" }
      vi.mocked(fetch).mockReturnValue(mockFetchResponse(mockCrumb))
      vi.mocked(common.httpPost).mockResolvedValue({ status: 200, headers: {} })

      const result = await client.copyJob("source-job", "copy-job")

      expect(result).toEqual({
        fromName: "source-job",
        newName: "copy-job",
        copied: true,
      })
      expect(common.httpPost).toHaveBeenCalledWith(
        expect.stringContaining("from=source-job"),
        expect.anything(),
      )
    })
  })

  describe("moveJob", () => {
    it("should move a job to an empty destination (no rename)", async () => {
      const mockCrumb = { crumbRequestField: "Jenkins-Crumb", crumb: "mv-crumb" }
      vi.mocked(fetch).mockReturnValue(mockFetchResponse(mockCrumb))
      // 1) destination GET → 404 (free)
      vi.mocked(common.httpGetJson).mockRejectedValueOnce(new Error("HTTP 404"))
      // 2) move POST → 302 with Location to new job URL (success)
      vi.mocked(common.httpPost).mockResolvedValue({
        status: 302,
        headers: { location: "/job/new-folder/job/my-job/" },
      })

      const result = await client.moveJob("old-folder/my-job", "new-folder/my-job")

      expect(result).toEqual({
        from: "old-folder/my-job",
        to: "new-folder/my-job",
        url: "https://jenkins.example.com/job/new-folder/job/my-job",
        renamed: false,
      })
      expect(common.httpGetJson).toHaveBeenCalledWith(
        "https://jenkins.example.com/job/new-folder/job/my-job/api/json",
        expect.objectContaining({
          headers: expect.objectContaining({
            "Jenkins-Crumb": "mv-crumb",
            "Content-Type": "application/x-www-form-urlencoded",
          }),
        }),
      )
      expect(common.httpPost).toHaveBeenCalledWith(
        "https://jenkins.example.com/job/old-folder/job/my-job/move/move",
        expect.objectContaining({
          headers: expect.objectContaining({
            "Jenkins-Crumb": "mv-crumb",
            "Content-Type": "application/x-www-form-urlencoded",
          }),
          body: "destination=%2Fnew-folder&Submit=Move",
        }),
      )
      // No DELETE happened
      expect(common.httpPost).toHaveBeenCalledTimes(1)
    })

    it("should move a job to root when destination has no parent folder", async () => {
      const mockCrumb = { crumbRequestField: "Jenkins-Crumb", crumb: "mv-crumb" }
      vi.mocked(fetch).mockReturnValue(mockFetchResponse(mockCrumb))
      vi.mocked(common.httpGetJson).mockRejectedValueOnce(new Error("HTTP 404"))
      vi.mocked(common.httpPost).mockResolvedValue({
        status: 302,
        headers: { location: "/job/my-job/" },
      })

      await client.moveJob("L3/my-job", "my-job")

      expect(common.httpPost).toHaveBeenCalledWith(
        "https://jenkins.example.com/job/L3/job/my-job/move/move",
        expect.objectContaining({ body: "destination=%2F&Submit=Move" }),
      )
    })

    it("should reject when basename differs (CloudBees doMove keeps the name)", async () => {
      // No HTTP should be made at all.
      await expect(
        client.moveJob("folder/old-name", "new-folder/new-name"),
      ).rejects.toThrow(/Move preserves the original name/)
      expect(common.httpGetJson).not.toHaveBeenCalled()
      expect(common.httpPost).not.toHaveBeenCalled()
    })

    it("should throw destinationConflict when destination is occupied and overwrite=false", async () => {
      const mockCrumb = { crumbRequestField: "Jenkins-Crumb", crumb: "mv-crumb" }
      vi.mocked(fetch).mockReturnValue(mockFetchResponse(mockCrumb))
      // destination GET → 200 (occupied)
      vi.mocked(common.httpGetJson).mockResolvedValueOnce({ name: "existing" })

      await expect(
        client.moveJob("src/job", "dest/job", false),
      ).rejects.toThrow("Job already exists at destination: dest/job")

      // Move must NOT be called
      expect(common.httpPost).not.toHaveBeenCalled()
    })

    it("should delete destination then move when overwrite=true", async () => {
      const mockCrumb = { crumbRequestField: "Jenkins-Crumb", crumb: "mv-crumb" }
      vi.mocked(fetch).mockReturnValue(mockFetchResponse(mockCrumb))
      // destination GET → 200
      vi.mocked(common.httpGetJson).mockResolvedValueOnce({ name: "existing" })
      // 1st POST = DELETE dest, 2nd POST = /move/move → success
      vi.mocked(common.httpPost)
        .mockResolvedValueOnce({ status: 200, headers: {} })
        .mockResolvedValueOnce({ status: 302, headers: { location: "/job/folderB/job/my-job/" } })

      const result = await client.moveJob("folderA/my-job", "folderB/my-job", true)

      expect(result).toEqual({
        from: "folderA/my-job",
        to: "folderB/my-job",
        url: "https://jenkins.example.com/job/folderB/job/my-job",
        renamed: false,
      })
      expect(common.httpPost).toHaveBeenCalledTimes(2)
      expect(common.httpPost).toHaveBeenNthCalledWith(
        1,
        "https://jenkins.example.com/job/folderB/job/my-job/doDelete",
        expect.anything(),
      )
      expect(common.httpPost).toHaveBeenNthCalledWith(
        2,
        "https://jenkins.example.com/job/folderA/job/my-job/move/move",
        expect.objectContaining({ body: "destination=%2FfolderB&Submit=Move" }),
      )
    })

    it("should short-circuit when src === dest without HTTP", async () => {
      const result = await client.moveJob("same", "same")

      expect(result).toEqual({
        from: "same",
        to: "same",
        url: "https://jenkins.example.com/job/same",
        renamed: false,
      })
      expect(common.httpGetJson).not.toHaveBeenCalled()
      expect(common.httpPost).not.toHaveBeenCalled()
    })

    it("should throw jobNotFound when /move/move returns 404", async () => {
      const mockCrumb = { crumbRequestField: "Jenkins-Crumb", crumb: "mv-crumb" }
      vi.mocked(fetch).mockReturnValue(mockFetchResponse(mockCrumb))
      vi.mocked(common.httpGetJson).mockRejectedValueOnce(new Error("HTTP 404"))
      vi.mocked(common.httpPost).mockResolvedValue({ status: 404, headers: {} })

      await expect(client.moveJob("missing/job", "dest/job")).rejects.toThrow(
        "Job not found: missing/job",
      )
    })

    it("should throw unexpected on non-404 error responses", async () => {
      const mockCrumb = { crumbRequestField: "Jenkins-Crumb", crumb: "mv-crumb" }
      vi.mocked(fetch).mockReturnValue(mockFetchResponse(mockCrumb))
      vi.mocked(common.httpGetJson).mockRejectedValueOnce(new Error("HTTP 404"))
      vi.mocked(common.httpPost).mockResolvedValue({ status: 500, headers: {} })

      await expect(client.moveJob("src/job", "dest/job")).rejects.toThrow(
        "Move job failed: HTTP 500",
      )
    })

    it("should throw unexpected when /move/move redirects back to the form page (Jenkins rejected)", async () => {
      const mockCrumb = { crumbRequestField: "Jenkins-Crumb", crumb: "mv-crumb" }
      vi.mocked(fetch).mockReturnValue(mockFetchResponse(mockCrumb))
      vi.mocked(common.httpGetJson).mockRejectedValueOnce(new Error("HTTP 404"))
      // 302 to the move form page = forwardToPreviousPage, validation failed
      vi.mocked(common.httpPost).mockResolvedValue({
        status: 302,
        headers: { location: "/job/src/job/move/" },
      })

      await expect(client.moveJob("src/job", "dest/job")).rejects.toThrow(
        /Move rejected by Jenkins/,
      )
    })

    it("should throw unexpected when destination delete fails during overwrite", async () => {
      const mockCrumb = { crumbRequestField: "Jenkins-Crumb", crumb: "mv-crumb" }
      vi.mocked(fetch).mockReturnValue(mockFetchResponse(mockCrumb))
      // destination GET → 200 (occupied)
      vi.mocked(common.httpGetJson).mockResolvedValueOnce({ name: "existing" })
      // 1st POST = doDelete → 403 (forbidden)
      vi.mocked(common.httpPost).mockResolvedValueOnce({ status: 403, headers: {} })

      await expect(
        client.moveJob("folderA/my-job", "folderB/my-job", true),
      ).rejects.toThrow("Delete existing job failed: HTTP 403")

      // Move must NOT be called after a failed delete
      expect(common.httpPost).toHaveBeenCalledTimes(1)
    })
  })

  describe("getJobConfigHistory", () => {
    it("should return normalized history entries", async () => {
      const mockResponse = {
        jobConfigHistory: [
          {
            date: "2026-06-04_17-40-09",
            operation: "Changed",
            user: "alice",
            userID: "alice",
            hasConfig: true,
            oldName: "",
            currentName: "",
            changeReasonComment: null,
          },
          {
            date: "2026-06-03_10-00-00",
            operation: "Created",
            user: null,
            userID: "system",
            hasConfig: true,
            oldName: "",
            currentName: "",
            changeReasonComment: null,
          },
        ],
      }
      vi.mocked(common.httpGetJson).mockResolvedValue(mockResponse)

      const result = await client.getJobConfigHistory("my-job")

      expect(result).toEqual({
        jobName: "my-job",
        entries: [
          {
            date: "2026-06-04_17-40-09",
            operation: "Changed",
            user: "alice",
            hasConfig: true,
            oldName: "",
            currentName: "",
            changeReasonComment: null,
          },
          {
            date: "2026-06-03_10-00-00",
            operation: "Created",
            user: "system",
            hasConfig: true,
            oldName: "",
            currentName: "",
            changeReasonComment: null,
          },
        ],
      })
      expect(common.httpGetJson).toHaveBeenCalledWith(
        "https://jenkins.example.com/job/my-job/jobConfigHistory/api/json",
        expect.anything(),
      )
    })

    it("should fall back to userID when user is null", async () => {
      vi.mocked(common.httpGetJson).mockResolvedValue({
        jobConfigHistory: [
          {
            date: "2026-06-04_17-40-09",
            operation: "Created",
            user: null,
            userID: "system",
            hasConfig: true,
            oldName: "",
            currentName: "",
            changeReasonComment: null,
          },
        ],
      })

      const result = await client.getJobConfigHistory("my-job")
      expect(result.entries[0].user).toBe("system")
    })

    it("should return empty entries when the plugin has no data", async () => {
      vi.mocked(common.httpGetJson).mockResolvedValue({ jobConfigHistory: [] })

      const result = await client.getJobConfigHistory("untouched-job")
      expect(result.entries).toEqual([])
    })

    it("should throw jobNotFound on 404", async () => {
      vi.mocked(common.httpGetJson).mockRejectedValue(new Error("HTTP 404"))

      await expect(client.getJobConfigHistory("missing")).rejects.toThrow(
        "Job not found: missing",
      )
    })
  })

  describe("diffJobConfigVersions", () => {
    it("should produce a unified diff between two versions", async () => {
      vi.mocked(common.httpGetText)
        .mockResolvedValueOnce("<x>1</x>\n<y>2</y>\n")
        .mockResolvedValueOnce("<x>1</x>\n<y>3</y>\n")

      const result = await client.diffJobConfigVersions(
        "my-job",
        "2026-06-01_00-00-00",
        "2026-06-02_00-00-00",
      )

      expect(result.identical).toBe(false)
      expect(result.fromTimestamp).toBe("2026-06-01_00-00-00")
      expect(result.toTimestamp).toBe("2026-06-02_00-00-00")
      expect(result.diff).toContain("--- 2026-06-01_00-00-00")
      expect(result.diff).toContain("+++ 2026-06-02_00-00-00")
      expect(result.diff).toContain("-<y>2</y>")
      expect(result.diff).toContain("+<y>3</y>")
      expect(common.httpGetText).toHaveBeenCalledTimes(2)
      // Both calls hit the same plugin endpoint with different timestamps
      const urls = vi.mocked(common.httpGetText).mock.calls.map((c) => c[0])
      expect(urls[0]).toContain("jobConfigHistory/configOutput?type=raw&timestamp=2026-06-01_00-00-00")
      expect(urls[1]).toContain("jobConfigHistory/configOutput?type=raw&timestamp=2026-06-02_00-00-00")
    })

    it("should report identical=true and empty diff when versions match", async () => {
      const same = "<x>1</x>\n"
      vi.mocked(common.httpGetText)
        .mockResolvedValueOnce(same)
        .mockResolvedValueOnce(same)

      const result = await client.diffJobConfigVersions(
        "my-job",
        "2026-06-01_00-00-00",
        "2026-06-01_00-00-00",
      )

      expect(result.identical).toBe(true)
      expect(result.diff).toBe("")
    })

    it("should surface a helpful error when fromTimestamp does not exist", async () => {
      // Unknown timestamp returns 200 with empty body (not 404) from the plugin.
      vi.mocked(common.httpGetText).mockResolvedValueOnce("")

      await expect(
        client.diffJobConfigVersions(
          "my-job",
          "no-such-ts",
          "2026-06-02_00-00-00",
        ),
      ).rejects.toThrow(/Config version not found: no-such-ts/)
    })

    it("should surface a helpful error when toTimestamp does not exist", async () => {
      vi.mocked(common.httpGetText)
        .mockResolvedValueOnce("<x>1</x>")
        .mockResolvedValueOnce("")

      await expect(
        client.diffJobConfigVersions(
          "my-job",
          "2026-06-01_00-00-00",
          "no-such-ts",
        ),
      ).rejects.toThrow(/Config version not found: no-such-ts/)
    })
  })

  describe("restoreJobConfigVersion", () => {
    it("should POST to the plugin's restore endpoint and return success", async () => {
      const mockCrumb = { crumbRequestField: "Jenkins-Crumb", crumb: "crumb-r" }
      vi.mocked(fetch).mockReturnValue(mockFetchResponse(mockCrumb))
      vi.mocked(common.httpPost).mockResolvedValue({ status: 302, headers: {} })

      const result = await client.restoreJobConfigVersion(
        "my-job",
        "2026-06-01_00-00-00",
      )

      expect(result).toEqual({
        jobName: "my-job",
        restoredFrom: "2026-06-01_00-00-00",
        restored: true,
      })
      expect(common.httpPost).toHaveBeenCalledWith(
        "https://jenkins.example.com/job/my-job/jobConfigHistory/restore?timestamp=2026-06-01_00-00-00",
        expect.anything(),
      )
    })

    it("should throw jobNotFound on 404", async () => {
      const mockCrumb = { crumbRequestField: "Jenkins-Crumb", crumb: "crumb-r" }
      vi.mocked(fetch).mockReturnValue(mockFetchResponse(mockCrumb))
      vi.mocked(common.httpPost).mockResolvedValue({ status: 404, headers: {} })

      await expect(
        client.restoreJobConfigVersion("missing", "2026-06-01_00-00-00"),
      ).rejects.toThrow("Job not found: missing")
    })

    it("should throw on 4xx/5xx with a helpful message", async () => {
      const mockCrumb = { crumbRequestField: "Jenkins-Crumb", crumb: "crumb-r" }
      vi.mocked(fetch).mockReturnValue(mockFetchResponse(mockCrumb))
      vi.mocked(common.httpPost).mockResolvedValue({ status: 500, headers: {} })

      await expect(
        client.restoreJobConfigVersion("my-job", "2026-06-01_00-00-00"),
      ).rejects.toThrow(/Restore config version failed: HTTP 500/)
    })
  })

  describe("getNode", () => {
    it("should return node details", async () => {
      const mockResponse = {
        displayName: "agent-1",
        offline: false,
        temporarilyOffline: false,
        offlineCauseReason: "",
        idle: true,
        numExecutors: 2,
        assignedLabels: [{ name: "linux" }],
        monitorData: {},
      }
      vi.mocked(common.httpGetJson).mockResolvedValue(mockResponse)

      const result = await client.getNode("agent-1")

      expect(result.name).toBe("agent-1")
      expect(result.offline).toBe(false)
      expect(result.assignedLabels).toEqual(["linux"])
    })

    it("should throw on 404", async () => {
      vi.mocked(common.httpGetJson).mockRejectedValue(new Error("HTTP 404"))

      await expect(client.getNode("missing-node")).rejects.toThrow(
        "Node not found",
      )
    })
  })

  describe("toggleNodeOffline", () => {
    it("should toggle node offline", async () => {
      const mockCrumb = { crumbRequestField: "Jenkins-Crumb", crumb: "crumb5" }
      vi.mocked(fetch).mockReturnValue(mockFetchResponse(mockCrumb))
      vi.mocked(common.httpPost).mockResolvedValue({ status: 200, headers: {} })

      const result = await client.toggleNodeOffline("agent-1", "maintenance")

      expect(result).toEqual({ nodeName: "agent-1", toggledOffline: true })
      expect(common.httpPost).toHaveBeenCalledWith(
        expect.stringContaining("agent-1/toggleOffline"),
        expect.anything(),
      )
    })
  })

  describe("listViews", () => {
    it("should return all views with jobs", async () => {
      const mockResponse = {
        views: [
          {
            name: "All",
            url: "http://jenkins/view/All/",
            jobs: [{ name: "job-1", url: "url1" }],
          },
          { name: "My View", url: "http://jenkins/view/My/", jobs: [] },
        ],
      }
      vi.mocked(common.httpGetJson).mockResolvedValue(mockResponse)

      const views = await client.listViews()

      expect(views).toHaveLength(2)
      expect(views[0].name).toBe("All")
      expect(views[0].jobs).toHaveLength(1)
    })

    it("should return empty array when no views", async () => {
      vi.mocked(common.httpGetJson).mockResolvedValue({ views: null })

      const views = await client.listViews()

      expect(views).toEqual([])
    })
  })

  describe("getView", () => {
    it("should return view details", async () => {
      const mockResponse = {
        name: "My View",
        url: "http://jenkins/view/My/",
        description: "My custom view",
        jobs: [{ name: "job-1", url: "url1", color: "blue" }],
      }
      vi.mocked(common.httpGetJson).mockResolvedValue(mockResponse)

      const view = await client.getView("My View")

      expect(view.name).toBe("My View")
      expect(view.jobs).toHaveLength(1)
      expect(view.jobs[0].color).toBe("blue")
    })

    it("should throw on 404", async () => {
      vi.mocked(common.httpGetJson).mockRejectedValue(new Error("HTTP 404"))

      await expect(client.getView("missing-view")).rejects.toThrow(
        "View not found",
      )
    })
  })

  describe("quietDown", () => {
    it("should enable quiet mode", async () => {
      const mockCrumb = { crumbRequestField: "Jenkins-Crumb", crumb: "crumb6" }
      vi.mocked(fetch).mockReturnValue(mockFetchResponse(mockCrumb))
      vi.mocked(common.httpPost).mockResolvedValue({ status: 200, headers: {} })

      const result = await client.quietDown("scheduled maintenance")

      expect(result).toEqual({ quietingDown: true })
      expect(common.httpPost).toHaveBeenCalledWith(
        expect.stringContaining("quietDown"),
        expect.anything(),
      )
    })
  })

  describe("cancelQuietDown", () => {
    it("should cancel quiet mode", async () => {
      const mockCrumb = { crumbRequestField: "Jenkins-Crumb", crumb: "crumb7" }
      vi.mocked(fetch).mockReturnValue(mockFetchResponse(mockCrumb))
      vi.mocked(common.httpPost).mockResolvedValue({ status: 200, headers: {} })

      const result = await client.cancelQuietDown()

      expect(result).toEqual({ quietingDown: false })
      expect(common.httpPost).toHaveBeenCalledWith(
        "https://jenkins.example.com/cancelQuietDown",
        expect.anything(),
      )
    })
  })

  describe("safeRestart", () => {
    it("should initiate safe restart", async () => {
      const mockCrumb = { crumbRequestField: "Jenkins-Crumb", crumb: "crumb8" }
      vi.mocked(fetch).mockReturnValue(mockFetchResponse(mockCrumb))
      vi.mocked(common.httpPost).mockResolvedValue({ status: 200, headers: {} })

      const result = await client.safeRestart()

      expect(result).toEqual({ restarting: true })
      expect(common.httpPost).toHaveBeenCalledWith(
        "https://jenkins.example.com/safeRestart",
        expect.anything(),
      )
    })
  })

  describe("replayBuild", () => {
    it("should replay a build with no body when mainScript is omitted", async () => {
      const mockCrumb = {
        crumbRequestField: "Jenkins-Crumb",
        crumb: "replay123",
      }
      vi.mocked(fetch).mockReturnValue(mockFetchResponse(mockCrumb))
      vi.mocked(common.httpPost).mockResolvedValue({
        headers: { location: "https://jenkins.example.com/queue/item/77/" },
      })

      const result = await client.replayBuild("my-pipeline", 5)

      expect(result).toEqual({
        jobName: "my-pipeline",
        buildNumber: 5,
        queueUrl: "https://jenkins.example.com/queue/item/77/",
      })
      expect(common.httpPost).toHaveBeenCalledWith(
        "https://jenkins.example.com/job/my-pipeline/5/replay/rebuild",
        expect.not.objectContaining({ body: expect.anything() }),
      )
      // Content-Type must NOT be set when there is no body
      const callArgs = vi.mocked(common.httpPost).mock.calls[0][1] as any
      expect(callArgs.headers?.["Content-Type"]).toBeUndefined()
    })

    it("should replay a build with form-encoded body when mainScript is provided", async () => {
      const mockCrumb = {
        crumbRequestField: "Jenkins-Crumb",
        crumb: "replay456",
      }
      vi.mocked(fetch).mockReturnValue(mockFetchResponse(mockCrumb))
      vi.mocked(common.httpPost).mockResolvedValue({
        headers: { location: "https://jenkins.example.com/queue/item/88/" },
      })

      const script =
        'pipeline { agent any; stages { stage("S") { steps { echo "ok" } } } }'
      const result = await client.replayBuild("my-pipeline", 10, script)

      expect(result).toEqual({
        jobName: "my-pipeline",
        buildNumber: 10,
        queueUrl: "https://jenkins.example.com/queue/item/88/",
      })
      expect(common.httpPost).toHaveBeenCalledWith(
        "https://jenkins.example.com/job/my-pipeline/10/replay/rebuild",
        expect.objectContaining({
          headers: expect.objectContaining({
            "Content-Type": "application/x-www-form-urlencoded",
          }),
          body: expect.stringContaining("mainScript="),
        }),
      )
      // Verify the body encodes the script correctly
      const callArgs = vi.mocked(common.httpPost).mock.calls[0][1] as any
      const params = new URLSearchParams(callArgs.body)
      expect(params.get("mainScript")).toBe(script)
    })

    it("should return null queueUrl when Jenkins supplies no Location header", async () => {
      const mockCrumb = {
        crumbRequestField: "Jenkins-Crumb",
        crumb: "replaynoloc",
      }
      vi.mocked(fetch).mockReturnValue(mockFetchResponse(mockCrumb))
      vi.mocked(common.httpPost).mockResolvedValue({ headers: {} })

      const result = await client.replayBuild("my-pipeline", 3)

      expect(result.queueUrl).toBeNull()
    })

    it("should throw job not found error on 404", async () => {
      const mockCrumb = {
        crumbRequestField: "Jenkins-Crumb",
        crumb: "replay404",
      }
      vi.mocked(fetch).mockReturnValue(mockFetchResponse(mockCrumb))
      vi.mocked(common.httpPost).mockResolvedValue({ status: 404, headers: {} })

      await expect(client.replayBuild("missing-pipeline", 1)).rejects.toThrow(
        "Job not found: missing-pipeline",
      )
    })
  })
})
