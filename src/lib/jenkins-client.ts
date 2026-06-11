import {
  httpGetJson,
  httpGetText,
  httpPost,
  Errors,
  McpError,
  logger,
  loadJenkinsEnv,
  unifiedDiff,
} from "../common/index.js"

import { basename, dirname } from "node:path"

const jobPath = (name: string): string =>
  name.split("/").map(encodeURIComponent).join("/job/")

export interface NormalizedBuild {
  id: string
  result: "SUCCESS" | "FAILURE" | "ABORTED" | "RUNNING" | string
  durationMs: number
  timestamp: string // ISO
  url: string
}

export interface JenkinsCredentials {
  baseUrl: string
  authHeader?: string
}

interface CrumbInfo {
  crumbRequestField: string
  crumb: string
}

export class JenkinsClient {
  readonly baseUrl: string
  private authHeader: string | undefined
  private crumb?: CrumbInfo
  private cookies: string | undefined

  constructor(credentials?: JenkinsCredentials) {
    if (credentials) {
      this.baseUrl = credentials.baseUrl
      this.authHeader = credentials.authHeader
    } else {
      const env = loadJenkinsEnv()
      this.baseUrl = env.JENKINS_URL

      if (env.JENKINS_ANONYMOUS) {
        this.authHeader = undefined
      } else if (env.JENKINS_BEARER_TOKEN) {
        this.authHeader = "Bearer " + env.JENKINS_BEARER_TOKEN
      } else {
        this.authHeader =
          "Basic " +
          Buffer.from(env.JENKINS_USER + ":" + env.JENKINS_API_TOKEN).toString(
            "base64",
          )
      }
    }
  }

  private headers(extra?: Record<string, string>): Record<string, string> {
    const h: Record<string, string> = {}
    if (this.authHeader) h["Authorization"] = this.authHeader
    if (this.cookies) h["Cookie"] = this.cookies
    return { ...h, ...extra }
  }

  // List jobs (shallow) returns name + url
  async listJobs(): Promise<{ name: string; url: string }[]> {
    try {
      const data = await httpGetJson<any>(`${this.baseUrl}/api/json`, {
        headers: this.headers(),
      })
      if (Array.isArray(data.jobs)) {
        return data.jobs.map((j: any) => ({ name: j.name, url: j.url }))
      }
      return []
    } catch (e: any) {
      if (e.message?.includes("HTTP 401")) throw Errors.authFailed()
      throw e
    }
  }

  // Recent builds metadata for a job (last N, default 5)
  async getRecentBuilds(
    jobName: string,
    limit = 5,
  ): Promise<NormalizedBuild[]> {
    try {
      const raw = await httpGetJson<any>(
        `${this.baseUrl}/job/${jobPath(jobName)}/api/json?depth=1`,
        { headers: this.headers() },
      )
      if (!raw.builds) return []
      const builds = raw.builds
        .slice(0, limit)
        .map((b: any) => this.normalizeBuild(b))
      return builds
    } catch (e: any) {
      if (e.message?.includes("HTTP 404")) throw Errors.jobNotFound(jobName)
      throw e
    }
  }

  private normalizeBuild(raw: any): NormalizedBuild {
    const building = raw.building === true
    const result = building ? "RUNNING" : raw.result || "RUNNING"
    return {
      id: String(raw.number ?? raw.id ?? ""),
      result,
      durationMs: raw.duration ?? 0,
      timestamp: raw.timestamp
        ? new Date(raw.timestamp).toISOString()
        : new Date().toISOString(),
      url: raw.url || "",
    }
  }

  async getLastBuild(jobName: string): Promise<NormalizedBuild> {
    try {
      const raw = await httpGetJson<any>(
        `${this.baseUrl}/job/${jobPath(jobName)}/lastBuild/api/json`,
        { headers: this.headers() },
      )
      return this.normalizeBuild(raw)
    } catch (e: any) {
      if (e.message?.includes("HTTP 404")) throw Errors.jobNotFound(jobName)
      throw e
    }
  }

  async getBuild(
    jobName: string,
    buildNumber: number,
  ): Promise<NormalizedBuild> {
    try {
      const raw = await httpGetJson<any>(
        `${this.baseUrl}/job/${jobPath(jobName)}/${buildNumber}/api/json`,
        { headers: this.headers() },
      )
      return this.normalizeBuild(raw)
    } catch (e: any) {
      if (e.message?.includes("HTTP 404")) throw Errors.jobNotFound(jobName)
      throw e
    }
  }

  async getConsoleLog(
    jobName: string,
    buildNumber?: number,
    maxSnippetLength = 200,
  ): Promise<{
    jobName: string
    buildNumber: number
    logSnippet: string
    fullLog: string
  }> {
    let bn = buildNumber
    if (bn == null) {
      bn = Number((await this.getLastBuild(jobName)).id)
    }
    try {
      const fullLog = await httpGetText(
        `${this.baseUrl}/job/${jobPath(jobName)}/${bn}/consoleText`,
        { headers: this.headers() },
      )
      const snippet = fullLog
        .trim()
        .slice(0, maxSnippetLength)
        .replace(/\r/g, "")
      return { jobName, buildNumber: bn, logSnippet: snippet, fullLog }
    } catch (e: any) {
      if (e.message?.includes("HTTP 404")) throw Errors.jobNotFound(jobName)
      throw e
    }
  }

  private async ensureCrumb(): Promise<CrumbInfo | undefined> {
    if (this.crumb) return this.crumb
    try {
      const controller = new AbortController()
      const t = setTimeout(() => controller.abort(), 10000)
      let res: Response
      try {
        res = await fetch(`${this.baseUrl}/crumbIssuer/api/json`, {
          headers: this.headers(),
          signal: controller.signal,
        })
      } finally {
        clearTimeout(t)
      }
      if (!res.ok) {
        logger.warn("Crumb fetch failed (continuing)", { status: res.status })
        return undefined
      }
      const setCookies: string[] =
        typeof (res.headers as any).getSetCookie === "function"
          ? (res.headers as any).getSetCookie()
          : ([res.headers.get("set-cookie")].filter(Boolean) as string[])
      if (setCookies.length > 0) {
        this.cookies = setCookies.map((c) => c.split(";")[0].trim()).join("; ")
      }
      const crumb = (await res.json()) as CrumbInfo
      this.crumb = crumb
      return crumb
    } catch (e: any) {
      logger.warn("Crumb fetch failed (continuing)", { error: String(e) })
      return undefined
    }
  }

  async triggerBuild(
    jobName: string,
    params?: Record<string, any>,
  ): Promise<{ jobName: string; queueUrl: string | null }> {
    const crumb = await this.ensureCrumb()
    const isParameterized = params && Object.keys(params).length > 0
    const path = isParameterized ? "buildWithParameters" : "build"
    const url = `${this.baseUrl}/job/${jobPath(jobName)}/${path}`
    let body: string | undefined
    const headers: Record<string, string> = this.headers()
    if (crumb) headers[crumb.crumbRequestField] = crumb.crumb
    if (isParameterized) {
      const usp = new URLSearchParams()
      for (const [k, v] of Object.entries(params!)) usp.append(k, String(v))
      body = usp.toString()
      headers["Content-Type"] = "application/x-www-form-urlencoded"
    }
    try {
      const res = await httpPost(url, { headers, body })
      const queueUrl = res.headers["location"] || null
      return { jobName, queueUrl }
    } catch (e: any) {
      if (e.message?.includes("HTTP 404")) throw Errors.jobNotFound(jobName)
      throw e
    }
  }

  async listArtifacts(
    jobName: string,
    buildNumber: number,
  ): Promise<
    { fileName: string; relativePath: string; url: string; size?: number }[]
  > {
    try {
      const data = await httpGetJson<any>(
        `${this.baseUrl}/job/${jobPath(jobName)}/${buildNumber}/api/json?tree=artifacts[fileName,relativePath]`,
        { headers: this.headers() },
      )
      if (!data || !Array.isArray(data.artifacts)) return []
      return data.artifacts.map((a: any) => ({
        fileName: a.fileName,
        relativePath: a.relativePath,
        url: `${this.baseUrl}/job/${jobPath(jobName)}/${buildNumber}/artifact/${a.relativePath}`,
      }))
    } catch (e: any) {
      if (e.message?.includes("HTTP 404")) throw Errors.jobNotFound(jobName)
      throw e
    }
  }

  async getArtifact(
    jobName: string,
    buildNumber: number,
    relativePath: string,
  ): Promise<{
    fileName: string
    relativePath: string
    size: number
    base64: string
  }> {
    const url = `${this.baseUrl}/job/${jobPath(jobName)}/${buildNumber}/artifact/${relativePath}`
    try {
      const data = await httpGetText(url, { headers: this.headers() })
      const buf = Buffer.from(data, "utf8")
      return {
        fileName: relativePath.split("/").pop() || relativePath,
        relativePath,
        size: buf.length,
        base64: buf.toString("base64"),
      }
    } catch (e: any) {
      if (e.message?.includes("HTTP 404"))
        throw Errors.artifactNotFound(relativePath)
      throw e
    }
  }

  async searchJobs(query: string): Promise<{ name: string; url: string }[]> {
    if (!query.trim()) return []
    const all = await this.listJobs()
    const q = query.toLowerCase()
    return all.filter((j) => j.name.toLowerCase().includes(q))
  }

  // Stop/abort a running build
  async stopBuild(
    jobName: string,
    buildNumber: number,
  ): Promise<{ jobName: string; buildNumber: number; stopped: boolean }> {
    const crumb = await this.ensureCrumb()
    const headers: Record<string, string> = this.headers()
    if (crumb) headers[crumb.crumbRequestField] = crumb.crumb

    try {
      await httpPost(
        `${this.baseUrl}/job/${jobPath(jobName)}/${buildNumber}/stop`,
        { headers },
      )
      return { jobName, buildNumber, stopped: true }
    } catch (e: any) {
      if (e.message?.includes("HTTP 404")) throw Errors.jobNotFound(jobName)
      throw e
    }
  }

  // Delete a build
  async deleteBuild(
    jobName: string,
    buildNumber: number,
  ): Promise<{ jobName: string; buildNumber: number; deleted: boolean }> {
    const crumb = await this.ensureCrumb()
    const headers: Record<string, string> = this.headers()
    if (crumb) headers[crumb.crumbRequestField] = crumb.crumb

    try {
      await httpPost(
        `${this.baseUrl}/job/${jobPath(jobName)}/${buildNumber}/doDelete`,
        { headers },
      )
      return { jobName, buildNumber, deleted: true }
    } catch (e: any) {
      if (e.message?.includes("HTTP 404")) throw Errors.jobNotFound(jobName)
      throw e
    }
  }

  // Get test results for a build
  async getTestResults(jobName: string, buildNumber: number): Promise<any> {
    try {
      const data = await httpGetJson<any>(
        `${this.baseUrl}/job/${jobPath(jobName)}/${buildNumber}/testReport/api/json`,
        { headers: this.headers() },
      )
      const totalTests = data.totalCount || 0
      // Fallback: if testReport shows 0 tests, try parsing console log for Robot results
      if (totalTests === 0) {
        const parsed = await this.parseRobotFromConsoleLog(jobName, buildNumber)
        return {
          jobName,
          buildNumber,
          totalTests: parsed.totalTests,
          passedTests: parsed.passedTests,
          failedTests: parsed.failedTests,
          skippedTests: parsed.skippedTests,
          duration: data.duration || 0,
          suites: data.suites || [],
          source: "console_log",
          consoleLogHint: parsed.consoleLogHint,
        }
      }
      return {
        jobName,
        buildNumber,
        totalTests,
        passedTests: data.passCount || 0,
        failedTests: data.failCount || 0,
        skippedTests: data.skipCount || 0,
        duration: data.duration || 0,
        suites: data.suites || [],
        source: "testReport",
      }
    } catch (e: any) {
      if (e.message?.includes("HTTP 404")) {
        // No test report at all — try console log as last resort
        const parsed = await this.parseRobotFromConsoleLog(jobName, buildNumber)
        return {
          jobName,
          buildNumber,
          totalTests: parsed.totalTests,
          passedTests: parsed.passedTests,
          failedTests: parsed.failedTests,
          skippedTests: parsed.skippedTests,
          duration: 0,
          suites: [],
          source: "console_log",
          consoleLogHint: parsed.consoleLogHint,
        }
      }
      throw e
    }
  }

  /**
   * Parse Robot Framework test results from console log when testReport API
   * fails to return meaningful data (e.g. output.xml files with non-standard
   * names or encoding issues).
   */
  private async parseRobotFromConsoleLog(
    jobName: string,
    buildNumber: number,
  ): Promise<{
    totalTests: number
    passedTests: number
    failedTests: number
    skippedTests: number
    consoleLogHint: string
  }> {
    try {
      const { fullLog } = await this.getConsoleLog(jobName, buildNumber)
      const lines = fullLog.split("\n")

      // Robot Framework summary patterns:
      //   "X test(s), Y passed, Z failed, W skipped"
      //   "X tests, Y passed, Z failed"  (no skipped)
      // Also handle multi-suite output like:
      //   "UNII3 ALL EU | PASS"  (suite name + status)
      //   "1 test, 1 passed, 0 failed"
      //   "Finished: SUCCESS"
      let totalTests = 0
      let passedTests = 0
      let failedTests = 0
      let skippedTests = 0
      let overallResult = "UNKNOWN"
      let hintLines: string[] = []

      for (const line of lines) {
        const trimmed = line.trim()

        // Robot summary: "N test(s), Y passed, Z failed, W skipped"
        const summaryMatch = trimmed.match(
          /(\d+)\s*tests?[,\s]+(\d+)\s*passed[,\s]+(\d+)\s*failed/i,
        )
        if (summaryMatch) {
          totalTests = parseInt(summaryMatch[1], 10)
          passedTests = parseInt(summaryMatch[2], 10)
          failedTests = parseInt(summaryMatch[3], 10)
          // Try to also get skipped count from same line
          const skipMatch = trimmed.match(/(\d+)\s*skipped/i)
          if (skipMatch) skippedTests = parseInt(skipMatch[1], 10)
        }

        // Alternative: "N test(s), Y passed, Z failed" (no skipped)
        if (totalTests === 0) {
          const altMatch = trimmed.match(
            /(\d+)\s*tests?[,\s]+(\d+)\s*passed[,\s]+(\d+)\s*failed/i,
          )
          if (altMatch) {
            totalTests = parseInt(altMatch[1], 10)
            passedTests = parseInt(altMatch[2], 10)
            failedTests = parseInt(altMatch[3], 10)
          }
        }

        // Robot suite result: "SuiteName | PASS|FAIL"
        const suiteMatch = trimmed.match(/^(.+?)\s*\|\s*(PASS|FAIL(?:URE)?)\s*$/i)
        if (suiteMatch) {
          hintLines.push(trimmed)
        }

        // Overall finish: "Finished: SUCCESS" / "Finished: FAILURE"
        const finishMatch = trimmed.match(/^Finished:\s*(SUCCESS|FAILURE)$/i)
        if (finishMatch) {
          overallResult = finishMatch[1].toUpperCase()
        }
      }

      // If we found no summary but there's a success finish and suite hints,
      // treat it as a single-test pass
      if (
        totalTests === 0 &&
        overallResult === "SUCCESS" &&
        hintLines.length > 0
      ) {
        // Extract actual counts from suite-level output if available
        const passMatch = fullLog.match(/(\d+)\s*test.*?(\d+)\s*passed.*?(\d+)\s*failed/i)
        if (passMatch) {
          totalTests = parseInt(passMatch[1], 10)
          passedTests = parseInt(passMatch[2], 10)
          failedTests = parseInt(passMatch[3], 10)
        } else {
          // Fallback: assume 1 test passed if overall SUCCESS
          totalTests = 1
          passedTests = 1
          failedTests = 0
        }
      }

      const hint = hintLines.slice(0, 5).join(" | ")
      return {
        totalTests,
        passedTests,
        failedTests,
        skippedTests,
        consoleLogHint: hint || overallResult,
      }
    } catch {
      // Console log also failed — return zeros
      return {
        totalTests: 0,
        passedTests: 0,
        failedTests: 0,
        skippedTests: 0,
        consoleLogHint: "console_log_unavailable",
      }
    }
  }

  // Get build queue
  async getQueue(): Promise<any[]> {
    try {
      const data = await httpGetJson<any>(`${this.baseUrl}/queue/api/json`, {
        headers: this.headers(),
      })
      if (!data.items) return []
      return data.items.map((item: any) => ({
        id: item.id,
        blocked: item.blocked || false,
        buildable: item.buildable || false,
        stuck: item.stuck || false,
        why: item.why || "",
        task: {
          name: item.task?.name || "",
          url: item.task?.url || "",
        },
        inQueueSince: item.inQueueSince
          ? new Date(item.inQueueSince).toISOString()
          : null,
      }))
    } catch (e: any) {
      throw e
    }
  }

  // Cancel queued build
  async cancelQueue(
    queueId: number,
  ): Promise<{ queueId: number; cancelled: boolean }> {
    const crumb = await this.ensureCrumb()
    const headers: Record<string, string> = this.headers()
    if (crumb) headers[crumb.crumbRequestField] = crumb.crumb

    try {
      await httpPost(`${this.baseUrl}/queue/cancelItem?id=${queueId}`, {
        headers,
      })
      return { queueId, cancelled: true }
    } catch (e: any) {
      throw e
    }
  }

  // Enable a job
  async enableJob(
    jobName: string,
  ): Promise<{ jobName: string; enabled: boolean }> {
    const crumb = await this.ensureCrumb()
    const headers: Record<string, string> = this.headers()
    if (crumb) headers[crumb.crumbRequestField] = crumb.crumb

    try {
      await httpPost(`${this.baseUrl}/job/${jobPath(jobName)}/enable`, {
        headers,
      })
      return { jobName, enabled: true }
    } catch (e: any) {
      if (e.message?.includes("HTTP 404")) throw Errors.jobNotFound(jobName)
      throw e
    }
  }

  // Disable a job
  async disableJob(
    jobName: string,
  ): Promise<{ jobName: string; disabled: boolean }> {
    const crumb = await this.ensureCrumb()
    const headers: Record<string, string> = this.headers()
    if (crumb) headers[crumb.crumbRequestField] = crumb.crumb

    try {
      await httpPost(`${this.baseUrl}/job/${jobPath(jobName)}/disable`, {
        headers,
      })
      return { jobName, disabled: true }
    } catch (e: any) {
      if (e.message?.includes("HTTP 404")) throw Errors.jobNotFound(jobName)
      throw e
    }
  }

  // Delete a job
  async deleteJob(
    jobName: string,
  ): Promise<{ jobName: string; deleted: boolean }> {
    const crumb = await this.ensureCrumb()
    const headers: Record<string, string> = this.headers()
    if (crumb) headers[crumb.crumbRequestField] = crumb.crumb

    try {
      await httpPost(`${this.baseUrl}/job/${jobPath(jobName)}/doDelete`, {
        headers,
      })
      return { jobName, deleted: true }
    } catch (e: any) {
      if (e.message?.includes("HTTP 404")) throw Errors.jobNotFound(jobName)
      throw e
    }
  }

  // Get job configuration (XML)
  async getJobConfig(
    jobName: string,
  ): Promise<{ jobName: string; config: string }> {
    try {
      const config = await httpGetText(
        `${this.baseUrl}/job/${jobPath(jobName)}/config.xml`,
        { headers: this.headers() },
      )
      return { jobName, config }
    } catch (e: any) {
      if (e.message?.includes("HTTP 404")) throw Errors.jobNotFound(jobName)
      throw e
    }
  }

  // Get parameter definitions for a parameterised job
  async getJobParameters(jobName: string): Promise<{
    jobName: string
    parameters: {
      name: string
      type: string
      description: string
      defaultValue: any
      choices?: string[]
    }[]
  }> {
    try {
      const data = await httpGetJson<any>(
        `${this.baseUrl}/job/${jobPath(jobName)}/api/json?tree=property[parameterDefinitions[name,type,description,defaultParameterValue[value],choices]]`,
        { headers: this.headers() },
      )
      const paramProp = (data.property ?? []).find(
        (p: any) =>
          p._class === "hudson.model.ParametersDefinitionProperty" ||
          Array.isArray(p.parameterDefinitions),
      )
      const defs: any[] = paramProp?.parameterDefinitions ?? []
      const parameters = defs.map((d: any) => {
        const raw: string = d.type ?? d._class ?? ""
        const type = raw
          .replace(/^.*\./, "")
          .replace(/ParameterDefinition$/, "")
          .toLowerCase()
        const entry: ReturnType<typeof Object.assign> = {
          name: d.name ?? "",
          type,
          description: d.description ?? "",
          defaultValue: d.defaultParameterValue?.value ?? null,
        }
        if (Array.isArray(d.choices)) entry.choices = d.choices
        return entry
      })
      return { jobName, parameters }
    } catch (e: any) {
      if (e.message?.includes("HTTP 404")) throw Errors.jobNotFound(jobName)
      throw e
    }
  }

  // List nodes/agents
  async listNodes(): Promise<any[]> {
    try {
      const data = await httpGetJson<any>(
        `${this.baseUrl}/computer/api/json?depth=1`,
        { headers: this.headers() },
      )
      if (!data.computer) return []
      return data.computer.map((node: any) => ({
        name: node.displayName || "",
        offline: node.offline || false,
        idle: node.idle || false,
        numExecutors: node.numExecutors || 0,
        busyExecutors: node.monitorData?.[
          "hudson.node_monitors.SwapSpaceMonitor"
        ]?.availablePhysicalMemory
          ? 0
          : node.numExecutors,
        temporarilyOffline: node.temporarilyOffline || false,
        offlineCauseReason: node.offlineCauseReason || "",
      }))
    } catch (e: any) {
      throw e
    }
  }

  // Get system info
  async getSystemInfo(): Promise<any> {
    try {
      const data = await httpGetJson<any>(`${this.baseUrl}/api/json`, {
        headers: this.headers(),
      })
      return {
        nodeDescription: data.nodeDescription || "",
        nodeName: data.nodeName || "",
        numExecutors: data.numExecutors || 0,
        mode: data.mode || "",
        quietingDown: data.quietingDown || false,
        useCrumbs: data.useCrumbs || false,
        useSecurity: data.useSecurity || false,
      }
    } catch (e: any) {
      throw e
    }
  }

  // Get Jenkins version
  async getVersion(): Promise<{ version: string }> {
    try {
      const res = await fetch(`${this.baseUrl}/api/json`, {
        method: "HEAD",
        headers: this.headers(),
      })
      const version = res.headers.get("x-jenkins") || "unknown"
      return { version }
    } catch (e: any) {
      throw e
    }
  }

  // Get installed plugins
  async getPlugins(): Promise<any[]> {
    try {
      const data = await httpGetJson<any>(
        `${this.baseUrl}/pluginManager/api/json?depth=1`,
        { headers: this.headers() },
      )
      if (!data.plugins) return []
      return data.plugins.map((plugin: any) => ({
        shortName: plugin.shortName || "",
        longName: plugin.longName || "",
        version: plugin.version || "",
        enabled: plugin.enabled || false,
        active: plugin.active || false,
        hasUpdate: plugin.hasUpdate || false,
      }))
    } catch (e: any) {
      throw e
    }
  }

  // Get build changes/commits
  async getBuildChanges(jobName: string, buildNumber: number): Promise<any> {
    try {
      const data = await httpGetJson<any>(
        `${this.baseUrl}/job/${jobPath(jobName)}/${buildNumber}/api/json?tree=changeSet[items[author[fullName],msg,commitId,timestamp]]`,
        { headers: this.headers() },
      )
      if (!data.changeSet || !data.changeSet.items) {
        return { jobName, buildNumber, changes: [] }
      }
      return {
        jobName,
        buildNumber,
        changes: data.changeSet.items.map((change: any) => ({
          author: change.author?.fullName || "unknown",
          message: change.msg || "",
          commitId: change.commitId || "",
          timestamp: change.timestamp
            ? new Date(change.timestamp).toISOString()
            : null,
        })),
      }
    } catch (e: any) {
      if (e.message?.includes("HTTP 404")) throw Errors.jobNotFound(jobName)
      throw e
    }
  }

  // Get pipeline stages
  async getPipelineStages(jobName: string, buildNumber: number): Promise<any> {
    try {
      const data = await httpGetJson<any>(
        `${this.baseUrl}/job/${jobPath(jobName)}/${buildNumber}/wfapi/describe`,
        { headers: this.headers() },
      )
      return {
        jobName,
        buildNumber,
        status: data.status || "",
        stages: (data.stages || []).map((stage: any) => ({
          id: stage.id || "",
          name: stage.name || "",
          status: stage.status || "",
          startTimeMillis: stage.startTimeMillis || 0,
          durationMillis: stage.durationMillis || 0,
          pauseDurationMillis: stage.pauseDurationMillis || 0,
        })),
      }
    } catch (e: any) {
      if (e.message?.includes("HTTP 404")) {
        return {
          jobName,
          buildNumber,
          message: "Not a pipeline build or workflow API not available",
        }
      }
      throw e
    }
  }

  async createJob(
    jobName: string,
    configXml: string,
  ): Promise<{ jobName: string; created: boolean }> {
    const crumb = await this.ensureCrumb()
    // The spec-compliant Content-Type per RFC 7303 is
    // `application/xml; charset=utf-8`. Jenkins's `createItem` endpoint is
    // lenient and accepts either form, but the matching `/config.xml`
    // update endpoint 500s on non-ASCII bodies when charset is omitted
    // (the XML declaration's encoding="UTF-8" alone is not enough for
    // Jenkins's parser — the HTTP-level charset has to match too). Send
    // it on both ends so the two endpoints stay symmetric.
    const headers: Record<string, string> = this.headers({
      "Content-Type": "application/xml; charset=utf-8",
    })
    if (crumb) headers[crumb.crumbRequestField] = crumb.crumb
    // For folder-scoped names like "L3/new_job", /createItem is the top-level
    // endpoint and Jenkins treats the slash as a literal name character —
    // 400 every time. Use the folder-relative endpoint instead, matching
    // how updateJobConfig routes through jobPath() for /config.xml.
    const slash = jobName.lastIndexOf("/")
    const url =
      slash === -1
        ? `${this.baseUrl}/createItem?name=${encodeURIComponent(jobName)}`
        : `${this.baseUrl}/job/${jobPath(jobName.slice(0, slash))}/createItem?name=${encodeURIComponent(jobName.slice(slash + 1))}`
    const res = await httpPost(url, { headers, body: configXml })
    if (res.status >= 400)
      throw Errors.unexpected(`Create job failed: HTTP ${res.status}`)
    return { jobName, created: true }
  }

  async updateJobConfig(
    jobName: string,
    configXml: string,
  ): Promise<{
    jobName: string
    updated: boolean
    verified: boolean
    warning?: string
  }> {
    const crumb = await this.ensureCrumb()
    // See createJob above for the charset rationale — the /config.xml
    // update endpoint 500s on non-ASCII bodies without `charset=utf-8`,
    // even when the XML declaration says encoding="UTF-8".
    const headers: Record<string, string> = this.headers({
      "Content-Type": "application/xml; charset=utf-8",
    })
    if (crumb) headers[crumb.crumbRequestField] = crumb.crumb
    let res: { status: number; headers: Record<string, string | null> }
    try {
      res = await httpPost(`${this.baseUrl}/job/${jobPath(jobName)}/config.xml`, {
        headers,
        body: configXml,
      })
    } catch (e: any) {
      if (e.message?.includes("HTTP 404")) throw Errors.jobNotFound(jobName)
      throw e
    }
    // httpPost only throws on 401 — for every other response (including 4xx/5xx
    // from Jenkins rejecting malformed XML, unsupported fields, etc.) it returns
    // silently. Without this check, the tool reported { updated: true } while
    // the config never took effect.
    if (res.status === 404) throw Errors.jobNotFound(jobName)
    if (res.status >= 400) {
      throw Errors.unexpected(
        `Update job config failed: HTTP ${res.status}. ` +
        `Jenkins rejected the config — check that the XML is well-formed and the fields are valid for this job type.`,
      )
    }
    // POST returned 2xx — re-read the config to confirm Jenkins actually
    // reloaded the job. The standard /config.xml POST writes the file and
    // reloads in one request, so this almost always matches. It can diverge
    // when a plugin (JCasC, Pipeline: Declarative, Multi-branch) caches the
    // parsed config in a way the POST doesn't invalidate — the file on disk
    // is correct but the running job still uses the old value. When that
    // happens, surface a warning so the agent knows to retry the POST or
    // call jenkins_safe_restart instead of trusting the success response.
    // Whitespace is normalized on both sides because Jenkins re-serializes
    // the XML it stores (different attribute order, line breaks, etc.) and
    // we don't want a re-format to look like a content mismatch. The
    // inter-element whitespace strip is the key one — Jenkins pretty-prints
    // with newlines+indentation between tags, the caller usually sends a
    // single line, and a naive `\s+ → " "` collapses them to a single space
    // that doesn't appear in the caller's payload.
    const norm = (s: string) =>
      s
        .replace(/<\?xml[^?]*\?>/g, "")
        .replace(/>\s+</g, "><")
        .trim()
    let verified = false
    let warning: string | undefined
    try {
      const gotXml = await httpGetText(
        `${this.baseUrl}/job/${jobPath(jobName)}/config.xml`,
        { headers: this.headers() },
      )
      if (norm(gotXml) === norm(configXml)) {
        verified = true
      } else {
        warning =
          `POST returned ${res.status} but re-reading the config shows a ` +
          `different value — Jenkins may not have reloaded the job. ` +
          `Retry the POST, or call jenkins_safe_restart to force a reload.`
      }
    } catch (e: any) {
      warning =
        `Updated on disk but could not re-fetch the config to verify ` +
        `(${e.message ?? String(e)}). If the change doesn't take effect, ` +
        `retry the POST or call jenkins_safe_restart.`
    }
    return { jobName, updated: true, verified, warning }
  }

  async renameJob(
    jobName: string,
    newName: string,
  ): Promise<{ oldName: string; newName: string; renamed: boolean }> {
    const crumb = await this.ensureCrumb()
    const headers: Record<string, string> = this.headers()
    if (crumb) headers[crumb.crumbRequestField] = crumb.crumb
    let res: { status: number; headers: Record<string, string | null> }
    try {
      // /rename is the form-page URL (GET only) and returns 404 on POST. The
      // action handler is /doRename — same pattern as RelocationAction's
      // doMove at /move/move.
      res = await httpPost(
        `${this.baseUrl}/job/${jobPath(jobName)}/doRename?newName=${encodeURIComponent(newName)}`,
        { headers },
      )
    } catch (e: any) {
      if (e.message?.includes("HTTP 404")) throw Errors.jobNotFound(jobName)
      throw e
    }
    // httpPost only throws on 401 — check 404/4xx/5xx explicitly so failures
    // don't get reported as success.
    if (res.status === 404) throw Errors.jobNotFound(jobName)
    if (res.status >= 400) {
      throw Errors.unexpected(
        `Rename job failed: HTTP ${res.status}. ` +
        `Check that the job exists, the new name is valid (no slashes/spaces, unique), and you have Create permission on the parent folder.`,
      )
    }
    return { oldName: jobName, newName, renamed: true }
  }

  async copyJob(
    fromName: string,
    newName: string,
  ): Promise<{ fromName: string; newName: string; copied: boolean }> {
    const crumb = await this.ensureCrumb()
    const headers: Record<string, string> = this.headers()
    if (crumb) headers[crumb.crumbRequestField] = crumb.crumb
    // For folder-scoped destinations, the same /createItem routing caveat
    // as createJob applies — use the folder-relative endpoint when the new
    // name contains a slash.
    const slash = newName.lastIndexOf("/")
    const url =
      slash === -1
        ? `${this.baseUrl}/createItem?name=${encodeURIComponent(newName)}&from=${encodeURIComponent(fromName)}&mode=copy`
        : `${this.baseUrl}/job/${jobPath(newName.slice(0, slash))}/createItem?name=${encodeURIComponent(newName.slice(slash + 1))}&from=${encodeURIComponent(fromName)}&mode=copy`
    try {
      const res = await httpPost(url, { headers })
      if (res.status >= 400)
        throw Errors.unexpected(`Copy job failed: HTTP ${res.status}`)
      return { fromName, newName, copied: true }
    } catch (e: any) {
      if (e.message?.includes("HTTP 404")) throw Errors.jobNotFound(fromName)
      throw e
    }
  }

  async moveJob(
    jobName: string,
    destination: string,
    overwrite = false,
  ): Promise<{ from: string; to: string; url: string; renamed: boolean }> {
    // No-op short-circuit
    if (jobName === destination) {
      return {
        from: jobName,
        to: destination,
        url: `${this.baseUrl}/job/${jobPath(destination)}`,
        renamed: false,
      }
    }

    // CloudBees RelocationAction.doMove keeps the original name. If the caller
    // wants a different basename, surface that explicitly so they can reach for
    // jenkins_rename_job instead of getting a silently-different URL.
    if (basename(jobName) !== basename(destination)) {
      throw Errors.unexpected(
        `Move preserves the original name (CloudBees RelocationAction does not support rename via /move). Use jenkins_rename_job to rename, or pass a destination with the same basename as the source. (source basename: ${basename(jobName)}, destination basename: ${basename(destination)})`,
      )
    }

    // CloudBees' doMove wants a target *container* path like "/L3" or "/"
    // (full job path "/L3/job_name" is not a valid container). The full target
    // URL we return uses the caller's full destination, but the wire form is the
    // parent folder only.
    const parent = dirname(destination)
    const jenkinsDestination = parent === "." ? "/" : `/${parent}`

    const crumb = await this.ensureCrumb()
    const headers: Record<string, string> = this.headers({
      "Content-Type": "application/x-www-form-urlencoded",
    })
    if (crumb) headers[crumb.crumbRequestField] = crumb.crumb

    // Pre-check: does the full destination path exist?
    let destExists = false
    try {
      await httpGetJson<any>(
        `${this.baseUrl}/job/${jobPath(destination)}/api/json`,
        { headers },
      )
      destExists = true
    } catch (e: any) {
      if (!e.message?.includes("HTTP 404")) throw e
      // 404 = destination is free
    }

    if (destExists) {
      if (!overwrite) {
        throw Errors.destinationConflict(destination)
      }
      const delRes = await httpPost(
        `${this.baseUrl}/job/${jobPath(destination)}/doDelete`,
        { headers },
      )
      if (delRes.status >= 400) {
        throw Errors.unexpected(`Delete existing job failed: HTTP ${delRes.status}`)
      }
    }

    // CloudBees RelocationAction.doMove lives at /job/<src>/move/move
    // (RelocationAction's URL name is "move", and doMove → "move" by Stapler
    // convention, so the absolute path is "move/move"). It accepts a
    // form-urlencoded body and returns 302 to the new job URL on success, or
    // 302 back to the form page (forwardToPreviousPage) on validation failure.
    const body = new URLSearchParams({
      destination: jenkinsDestination,
      Submit: "Move",
    }).toString()
    const res = await httpPost(
      `${this.baseUrl}/job/${jobPath(jobName)}/move/move`,
      { headers, body },
    )

    if (res.status === 404) throw Errors.jobNotFound(jobName)
    if (res.status >= 400) {
      throw Errors.unexpected(`Move job failed: HTTP ${res.status}`)
    }
    if (res.status === 302) {
      // Success: Location is the new job URL.
      // Failure (forwardToPreviousPage): Location is /job/<src>/move/.
      const location = (res.headers["location"] ?? "") as string
      if (!location || /\/move\/?$/.test(location)) {
        throw Errors.unexpected(
          `Move rejected by Jenkins (destination=${jenkinsDestination}). ` +
          `Check that the destination folder exists and you have Create permission there.`,
        )
      }
    }

    return {
      from: jobName,
      to: destination,
      url: `${this.baseUrl}/job/${jobPath(destination)}`,
      renamed: false,
    }
  }

  async getNode(nodeName: string): Promise<any> {
    try {
      const data = await httpGetJson<any>(
        `${this.baseUrl}/computer/${encodeURIComponent(nodeName)}/api/json?depth=1`,
        { headers: this.headers() },
      )
      return {
        name: data.displayName || nodeName,
        offline: data.offline || false,
        temporarilyOffline: data.temporarilyOffline || false,
        offlineCauseReason: data.offlineCauseReason || "",
        idle: data.idle || false,
        numExecutors: data.numExecutors || 0,
        assignedLabels: (data.assignedLabels || []).map((l: any) => l.name),
        monitorData: data.monitorData || {},
      }
    } catch (e: any) {
      if (e.message?.includes("HTTP 404"))
        throw new McpError("NODE_NOT_FOUND", `Node not found: ${nodeName}`, 404)
      throw e
    }
  }

  async toggleNodeOffline(
    nodeName: string,
    offlineMessage = "",
  ): Promise<{ nodeName: string; toggledOffline: boolean }> {
    const crumb = await this.ensureCrumb()
    const headers: Record<string, string> = this.headers()
    if (crumb) headers[crumb.crumbRequestField] = crumb.crumb
    try {
      await httpPost(
        `${this.baseUrl}/computer/${encodeURIComponent(nodeName)}/toggleOffline?offlineMessage=${encodeURIComponent(offlineMessage)}`,
        { headers },
      )
      return { nodeName, toggledOffline: true }
    } catch (e: any) {
      if (e.message?.includes("HTTP 404"))
        throw new McpError("NODE_NOT_FOUND", `Node not found: ${nodeName}`, 404)
      throw e
    }
  }

  async listViews(): Promise<
    { name: string; url: string; jobs: { name: string; url: string }[] }[]
  > {
    const data = await httpGetJson<any>(
      `${this.baseUrl}/api/json?tree=views[name,url,jobs[name,url]]`,
      { headers: this.headers() },
    )
    if (!Array.isArray(data.views)) return []
    return data.views.map((v: any) => ({
      name: v.name || "",
      url: v.url || "",
      jobs: (v.jobs || []).map((j: any) => ({ name: j.name, url: j.url })),
    }))
  }

  async getView(viewName: string): Promise<any> {
    try {
      const data = await httpGetJson<any>(
        `${this.baseUrl}/view/${encodeURIComponent(viewName)}/api/json`,
        { headers: this.headers() },
      )
      return {
        name: data.name || viewName,
        url: data.url || "",
        description: data.description || "",
        jobs: (data.jobs || []).map((j: any) => ({
          name: j.name,
          url: j.url,
          color: j.color,
        })),
      }
    } catch (e: any) {
      if (e.message?.includes("HTTP 404"))
        throw new McpError("VIEW_NOT_FOUND", `View not found: ${viewName}`, 404)
      throw e
    }
  }

  async quietDown(reason = ""): Promise<{ quietingDown: boolean }> {
    const crumb = await this.ensureCrumb()
    const headers: Record<string, string> = this.headers()
    if (crumb) headers[crumb.crumbRequestField] = crumb.crumb
    const url = reason
      ? `${this.baseUrl}/quietDown?reason=${encodeURIComponent(reason)}`
      : `${this.baseUrl}/quietDown`
    await httpPost(url, { headers })
    return { quietingDown: true }
  }

  async cancelQuietDown(): Promise<{ quietingDown: boolean }> {
    const crumb = await this.ensureCrumb()
    const headers: Record<string, string> = this.headers()
    if (crumb) headers[crumb.crumbRequestField] = crumb.crumb
    await httpPost(`${this.baseUrl}/cancelQuietDown`, { headers })
    return { quietingDown: false }
  }

  async safeRestart(): Promise<{ restarting: boolean }> {
    const crumb = await this.ensureCrumb()
    const headers: Record<string, string> = this.headers()
    if (crumb) headers[crumb.crumbRequestField] = crumb.crumb
    await httpPost(`${this.baseUrl}/safeRestart`, { headers })
    return { restarting: true }
  }

  // Replay build (for pipeline jobs)
  async replayBuild(
    jobName: string,
    buildNumber: number,
    mainScript?: string,
  ): Promise<{
    jobName: string
    buildNumber: number
    queueUrl: string | null
  }> {
    const crumb = await this.ensureCrumb()
    const headers: Record<string, string> = this.headers()
    if (crumb) headers[crumb.crumbRequestField] = crumb.crumb

    const init: RequestInit & { timeoutMs?: number } = { headers }
    if (mainScript !== undefined) {
      headers["Content-Type"] = "application/x-www-form-urlencoded"
      init.body = new URLSearchParams({ mainScript }).toString()
    }
    const res = await httpPost(
      `${this.baseUrl}/job/${jobPath(jobName)}/${buildNumber}/replay/rebuild`,
      init,
    )
    if (res.status === 404) throw Errors.jobNotFound(jobName)
    if (res.status >= 400)
      throw Errors.unexpected(`Replay failed with status ${res.status}`)
    return { jobName, buildNumber, queueUrl: res.headers["location"] || null }
  }

  // --- Job Configuration History (jobConfigHistory plugin) --------------------
  // The plugin stores prior versions of every job's XML and exposes them under
  // /job/<name>/jobConfigHistory/. Without it, an agent has no way to undo a
  // bad update_job_config — the restore below is the safety net for that.

  async getJobConfigHistory(
    jobName: string,
  ): Promise<{
    jobName: string
    entries: Array<{
      date: string
      operation: string
      user: string
      hasConfig: boolean
      oldName: string
      currentName: string
      changeReasonComment: string | null
    }>
  }> {
    let data: any
    try {
      data = await httpGetJson<any>(
        `${this.baseUrl}/job/${jobPath(jobName)}/jobConfigHistory/api/json`,
        { headers: this.headers() },
      )
    } catch (e: any) {
      if (e.message?.includes("HTTP 404")) throw Errors.jobNotFound(jobName)
      if (e.message?.includes("HTTP 403")) {
        throw Errors.unexpected(
          `Job Configuration History plugin is not accessible for ${jobName}. ` +
          `Check that the plugin is installed and that the user has Job/Configure permission.`,
        )
      }
      throw e
    }
    const raw = Array.isArray(data?.jobConfigHistory) ? data.jobConfigHistory : []
    return {
      jobName,
      entries: raw.map((e: any) => ({
        date: e.date,
        operation: e.operation,
        user: e.user ?? e.userID ?? "",
        hasConfig: e.hasConfig === true,
        oldName: e.oldName ?? "",
        currentName: e.currentName ?? "",
        changeReasonComment: e.changeReasonComment ?? null,
      })),
    }
  }

  async diffJobConfigVersions(
    jobName: string,
    fromTimestamp: string,
    toTimestamp: string,
  ): Promise<{
    jobName: string
    fromTimestamp: string
    toTimestamp: string
    identical: boolean
    diff: string
  }> {
    // Fetch both XMLs from the plugin. Doing the diff client-side avoids
    // parsing the plugin's side-by-side HTML diff view, which is awkward to
    // extract reliably. Line-based LCS is sufficient for Jenkins config XML
    // since the controller pretty-prints it deterministically.
    //
    // The plugin exposes the config for a given timestamp at
    // `configOutput?type=raw&timestamp=<ts>` — NOT `api/xml?timestamp=...`,
    // which silently returns the entry list and ignores the timestamp filter.
    // An unknown timestamp returns 200 with an empty body rather than 404.
    // The endpoint can be slow (40s+) on the first cold-cache hit per
    // (job, timestamp), then ~40ms after — give it a generous timeout.
    const base = `${this.baseUrl}/job/${jobPath(jobName)}/jobConfigHistory/configOutput`
    const fetchVersion = async (ts: string): Promise<string> => {
      let body: string
      try {
        body = await httpGetText(
          `${base}?type=raw&timestamp=${encodeURIComponent(ts)}`,
          { headers: this.headers(), timeoutMs: 60000 },
        )
      } catch (e: any) {
        if (e.message?.includes("HTTP 404")) {
          throw Errors.unexpected(
            `Config version not found: ${ts} for job ${jobName}. ` +
            `Use get_job_config_history to see available timestamps.`,
          )
        }
        throw e
      }
      if (!body || body.length === 0) {
        throw Errors.unexpected(
          `Config version not found: ${ts} for job ${jobName}. ` +
          `Use get_job_config_history to see available timestamps.`,
        )
      }
      return body
    }
    const fromXml = await fetchVersion(fromTimestamp)
    const toXml = await fetchVersion(toTimestamp)
    const identical = fromXml === toXml
    const diff = identical
      ? ""
      : unifiedDiff(fromXml, toXml, fromTimestamp, toTimestamp)
    return { jobName, fromTimestamp, toTimestamp, identical, diff }
  }

  async restoreJobConfigVersion(
    jobName: string,
    timestamp: string,
  ): Promise<{ jobName: string; restoredFrom: string; restored: boolean }> {
    const crumb = await this.ensureCrumb()
    const headers: Record<string, string> = this.headers()
    if (crumb) headers[crumb.crumbRequestField] = crumb.crumb
    let res: { status: number; headers: Record<string, string | null> }
    try {
      // Endpoint discovered by reading the plugin's restore-config.js: the
      // form action is `restore?<query>` and POSTs to /job/<name>/jobConfigHistory/restore.
      // The Jenkins handler returns 302 on success (Stapler redirect to the job
      // page). On bad timestamp or insufficient perms, Jenkins returns 4xx/5xx.
      res = await httpPost(
        `${this.baseUrl}/job/${jobPath(jobName)}/jobConfigHistory/restore?timestamp=${encodeURIComponent(timestamp)}`,
        { headers },
      )
    } catch (e: any) {
      if (e.message?.includes("HTTP 404")) throw Errors.jobNotFound(jobName)
      throw e
    }
    if (res.status === 404) throw Errors.jobNotFound(jobName)
    if (res.status >= 400) {
      throw Errors.unexpected(
        `Restore config version failed: HTTP ${res.status}. ` +
        `Check that the timestamp ${timestamp} exists in this job's history ` +
        `and you have Job/Configure permission.`,
      )
    }
    return { jobName, restoredFrom: timestamp, restored: true }
  }
}

export const createClient = () => new JenkinsClient()
