import { httpGetJson, httpGetText, httpPost, Errors, McpError, logger, loadJenkinsEnv, } from "../common/index.js";
const jobPath = (name) => name.split("/").map(encodeURIComponent).join("/job/");
export class JenkinsClient {
    baseUrl;
    authHeader;
    crumb;
    cookies;
    constructor(credentials) {
        if (credentials) {
            this.baseUrl = credentials.baseUrl;
            this.authHeader = credentials.authHeader;
        }
        else {
            const env = loadJenkinsEnv();
            this.baseUrl = env.JENKINS_URL;
            if (env.JENKINS_ANONYMOUS) {
                this.authHeader = undefined;
            }
            else if (env.JENKINS_BEARER_TOKEN) {
                this.authHeader = "Bearer " + env.JENKINS_BEARER_TOKEN;
            }
            else {
                this.authHeader =
                    "Basic " +
                        Buffer.from(env.JENKINS_USER + ":" + env.JENKINS_API_TOKEN).toString("base64");
            }
        }
    }
    headers(extra) {
        const h = {};
        if (this.authHeader)
            h["Authorization"] = this.authHeader;
        if (this.cookies)
            h["Cookie"] = this.cookies;
        return { ...h, ...extra };
    }
    // List jobs (shallow) returns name + url
    async listJobs() {
        try {
            const data = await httpGetJson(`${this.baseUrl}/api/json`, {
                headers: this.headers(),
            });
            if (Array.isArray(data.jobs)) {
                return data.jobs.map((j) => ({ name: j.name, url: j.url }));
            }
            return [];
        }
        catch (e) {
            if (e.message?.includes("HTTP 401"))
                throw Errors.authFailed();
            throw e;
        }
    }
    // Recent builds metadata for a job (last N, default 5)
    async getRecentBuilds(jobName, limit = 5) {
        try {
            const raw = await httpGetJson(`${this.baseUrl}/job/${jobPath(jobName)}/api/json?depth=1`, { headers: this.headers() });
            if (!raw.builds)
                return [];
            const builds = raw.builds
                .slice(0, limit)
                .map((b) => this.normalizeBuild(b));
            return builds;
        }
        catch (e) {
            if (e.message?.includes("HTTP 404"))
                throw Errors.jobNotFound(jobName);
            throw e;
        }
    }
    normalizeBuild(raw) {
        const building = raw.building === true;
        const result = building ? "RUNNING" : raw.result || "RUNNING";
        return {
            id: String(raw.number ?? raw.id ?? ""),
            result,
            durationMs: raw.duration ?? 0,
            timestamp: raw.timestamp
                ? new Date(raw.timestamp).toISOString()
                : new Date().toISOString(),
            url: raw.url || "",
        };
    }
    async getLastBuild(jobName) {
        try {
            const raw = await httpGetJson(`${this.baseUrl}/job/${jobPath(jobName)}/lastBuild/api/json`, { headers: this.headers() });
            return this.normalizeBuild(raw);
        }
        catch (e) {
            if (e.message?.includes("HTTP 404"))
                throw Errors.jobNotFound(jobName);
            throw e;
        }
    }
    async getBuild(jobName, buildNumber) {
        try {
            const raw = await httpGetJson(`${this.baseUrl}/job/${jobPath(jobName)}/${buildNumber}/api/json`, { headers: this.headers() });
            return this.normalizeBuild(raw);
        }
        catch (e) {
            if (e.message?.includes("HTTP 404"))
                throw Errors.jobNotFound(jobName);
            throw e;
        }
    }
    async getConsoleLog(jobName, buildNumber, maxSnippetLength = 200) {
        let bn = buildNumber;
        if (bn == null) {
            bn = Number((await this.getLastBuild(jobName)).id);
        }
        try {
            const fullLog = await httpGetText(`${this.baseUrl}/job/${jobPath(jobName)}/${bn}/consoleText`, { headers: this.headers() });
            const snippet = fullLog
                .trim()
                .slice(0, maxSnippetLength)
                .replace(/\r/g, "");
            return { jobName, buildNumber: bn, logSnippet: snippet, fullLog };
        }
        catch (e) {
            if (e.message?.includes("HTTP 404"))
                throw Errors.jobNotFound(jobName);
            throw e;
        }
    }
    async ensureCrumb() {
        if (this.crumb)
            return this.crumb;
        try {
            const controller = new AbortController();
            const t = setTimeout(() => controller.abort(), 10000);
            let res;
            try {
                res = await fetch(`${this.baseUrl}/crumbIssuer/api/json`, {
                    headers: this.headers(),
                    signal: controller.signal,
                });
            }
            finally {
                clearTimeout(t);
            }
            if (!res.ok) {
                logger.warn("Crumb fetch failed (continuing)", { status: res.status });
                return undefined;
            }
            const setCookies = typeof res.headers.getSetCookie === "function"
                ? res.headers.getSetCookie()
                : [res.headers.get("set-cookie")].filter(Boolean);
            if (setCookies.length > 0) {
                this.cookies = setCookies.map((c) => c.split(";")[0].trim()).join("; ");
            }
            const crumb = (await res.json());
            this.crumb = crumb;
            return crumb;
        }
        catch (e) {
            logger.warn("Crumb fetch failed (continuing)", { error: String(e) });
            return undefined;
        }
    }
    async triggerBuild(jobName, params) {
        const crumb = await this.ensureCrumb();
        const isParameterized = params && Object.keys(params).length > 0;
        const path = isParameterized ? "buildWithParameters" : "build";
        const url = `${this.baseUrl}/job/${jobPath(jobName)}/${path}`;
        let body;
        const headers = this.headers();
        if (crumb)
            headers[crumb.crumbRequestField] = crumb.crumb;
        if (isParameterized) {
            const usp = new URLSearchParams();
            for (const [k, v] of Object.entries(params))
                usp.append(k, String(v));
            body = usp.toString();
            headers["Content-Type"] = "application/x-www-form-urlencoded";
        }
        try {
            const res = await httpPost(url, { headers, body });
            const queueUrl = res.headers["location"] || null;
            return { jobName, queueUrl };
        }
        catch (e) {
            if (e.message?.includes("HTTP 404"))
                throw Errors.jobNotFound(jobName);
            throw e;
        }
    }
    async listArtifacts(jobName, buildNumber) {
        try {
            const data = await httpGetJson(`${this.baseUrl}/job/${jobPath(jobName)}/${buildNumber}/api/json?tree=artifacts[fileName,relativePath]`, { headers: this.headers() });
            if (!data || !Array.isArray(data.artifacts))
                return [];
            return data.artifacts.map((a) => ({
                fileName: a.fileName,
                relativePath: a.relativePath,
                url: `${this.baseUrl}/job/${jobPath(jobName)}/${buildNumber}/artifact/${a.relativePath}`,
            }));
        }
        catch (e) {
            if (e.message?.includes("HTTP 404"))
                throw Errors.jobNotFound(jobName);
            throw e;
        }
    }
    async getArtifact(jobName, buildNumber, relativePath) {
        const url = `${this.baseUrl}/job/${jobPath(jobName)}/${buildNumber}/artifact/${relativePath}`;
        try {
            const data = await httpGetText(url, { headers: this.headers() });
            const buf = Buffer.from(data, "utf8");
            return {
                fileName: relativePath.split("/").pop() || relativePath,
                relativePath,
                size: buf.length,
                base64: buf.toString("base64"),
            };
        }
        catch (e) {
            if (e.message?.includes("HTTP 404"))
                throw Errors.artifactNotFound(relativePath);
            throw e;
        }
    }
    async searchJobs(query) {
        if (!query.trim())
            return [];
        const all = await this.listJobs();
        const q = query.toLowerCase();
        return all.filter((j) => j.name.toLowerCase().includes(q));
    }
    // Stop/abort a running build
    async stopBuild(jobName, buildNumber) {
        const crumb = await this.ensureCrumb();
        const headers = this.headers();
        if (crumb)
            headers[crumb.crumbRequestField] = crumb.crumb;
        try {
            await httpPost(`${this.baseUrl}/job/${jobPath(jobName)}/${buildNumber}/stop`, { headers });
            return { jobName, buildNumber, stopped: true };
        }
        catch (e) {
            if (e.message?.includes("HTTP 404"))
                throw Errors.jobNotFound(jobName);
            throw e;
        }
    }
    // Delete a build
    async deleteBuild(jobName, buildNumber) {
        const crumb = await this.ensureCrumb();
        const headers = this.headers();
        if (crumb)
            headers[crumb.crumbRequestField] = crumb.crumb;
        try {
            await httpPost(`${this.baseUrl}/job/${jobPath(jobName)}/${buildNumber}/doDelete`, { headers });
            return { jobName, buildNumber, deleted: true };
        }
        catch (e) {
            if (e.message?.includes("HTTP 404"))
                throw Errors.jobNotFound(jobName);
            throw e;
        }
    }
    // Get test results for a build
    async getTestResults(jobName, buildNumber) {
        try {
            const data = await httpGetJson(`${this.baseUrl}/job/${jobPath(jobName)}/${buildNumber}/testReport/api/json`, { headers: this.headers() });
            const totalTests = data.totalCount || 0;
            // Fallback: if testReport shows 0 tests, try parsing console log for Robot results
            if (totalTests === 0) {
                const parsed = await this.parseRobotFromConsoleLog(jobName, buildNumber);
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
                };
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
            };
        }
        catch (e) {
            if (e.message?.includes("HTTP 404")) {
                // No test report at all — try console log as last resort
                const parsed = await this.parseRobotFromConsoleLog(jobName, buildNumber);
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
                };
            }
            throw e;
        }
    }
    /**
     * Parse Robot Framework test results from console log when testReport API
     * fails to return meaningful data (e.g. output.xml files with non-standard
     * names or encoding issues).
     */
    async parseRobotFromConsoleLog(jobName, buildNumber) {
        try {
            const { fullLog } = await this.getConsoleLog(jobName, buildNumber);
            const lines = fullLog.split("\n");
            // Robot Framework summary patterns:
            //   "X test(s), Y passed, Z failed, W skipped"
            //   "X tests, Y passed, Z failed"  (no skipped)
            // Also handle multi-suite output like:
            //   "UNII3 ALL EU | PASS"  (suite name + status)
            //   "1 test, 1 passed, 0 failed"
            //   "Finished: SUCCESS"
            let totalTests = 0;
            let passedTests = 0;
            let failedTests = 0;
            let skippedTests = 0;
            let overallResult = "UNKNOWN";
            let hintLines = [];
            for (const line of lines) {
                const trimmed = line.trim();
                // Robot summary: "N test(s), Y passed, Z failed, W skipped"
                const summaryMatch = trimmed.match(/(\d+)\s*tests?[,\s]+(\d+)\s*passed[,\s]+(\d+)\s*failed/i);
                if (summaryMatch) {
                    totalTests = parseInt(summaryMatch[1], 10);
                    passedTests = parseInt(summaryMatch[2], 10);
                    failedTests = parseInt(summaryMatch[3], 10);
                    // Try to also get skipped count from same line
                    const skipMatch = trimmed.match(/(\d+)\s*skipped/i);
                    if (skipMatch)
                        skippedTests = parseInt(skipMatch[1], 10);
                }
                // Alternative: "N test(s), Y passed, Z failed" (no skipped)
                if (totalTests === 0) {
                    const altMatch = trimmed.match(/(\d+)\s*tests?[,\s]+(\d+)\s*passed[,\s]+(\d+)\s*failed/i);
                    if (altMatch) {
                        totalTests = parseInt(altMatch[1], 10);
                        passedTests = parseInt(altMatch[2], 10);
                        failedTests = parseInt(altMatch[3], 10);
                    }
                }
                // Robot suite result: "SuiteName | PASS|FAIL"
                const suiteMatch = trimmed.match(/^(.+?)\s*\|\s*(PASS|FAIL(?:URE)?)\s*$/i);
                if (suiteMatch) {
                    hintLines.push(trimmed);
                }
                // Overall finish: "Finished: SUCCESS" / "Finished: FAILURE"
                const finishMatch = trimmed.match(/^Finished:\s*(SUCCESS|FAILURE)$/i);
                if (finishMatch) {
                    overallResult = finishMatch[1].toUpperCase();
                }
            }
            // If we found no summary but there's a success finish and suite hints,
            // treat it as a single-test pass
            if (totalTests === 0 &&
                overallResult === "SUCCESS" &&
                hintLines.length > 0) {
                // Extract actual counts from suite-level output if available
                const passMatch = fullLog.match(/(\d+)\s*test.*?(\d+)\s*passed.*?(\d+)\s*failed/i);
                if (passMatch) {
                    totalTests = parseInt(passMatch[1], 10);
                    passedTests = parseInt(passMatch[2], 10);
                    failedTests = parseInt(passMatch[3], 10);
                }
                else {
                    // Fallback: assume 1 test passed if overall SUCCESS
                    totalTests = 1;
                    passedTests = 1;
                    failedTests = 0;
                }
            }
            const hint = hintLines.slice(0, 5).join(" | ");
            return {
                totalTests,
                passedTests,
                failedTests,
                skippedTests,
                consoleLogHint: hint || overallResult,
            };
        }
        catch {
            // Console log also failed — return zeros
            return {
                totalTests: 0,
                passedTests: 0,
                failedTests: 0,
                skippedTests: 0,
                consoleLogHint: "console_log_unavailable",
            };
        }
    }
    // Get build queue
    async getQueue() {
        try {
            const data = await httpGetJson(`${this.baseUrl}/queue/api/json`, {
                headers: this.headers(),
            });
            if (!data.items)
                return [];
            return data.items.map((item) => ({
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
            }));
        }
        catch (e) {
            throw e;
        }
    }
    // Cancel queued build
    async cancelQueue(queueId) {
        const crumb = await this.ensureCrumb();
        const headers = this.headers();
        if (crumb)
            headers[crumb.crumbRequestField] = crumb.crumb;
        try {
            await httpPost(`${this.baseUrl}/queue/cancelItem?id=${queueId}`, {
                headers,
            });
            return { queueId, cancelled: true };
        }
        catch (e) {
            throw e;
        }
    }
    // Enable a job
    async enableJob(jobName) {
        const crumb = await this.ensureCrumb();
        const headers = this.headers();
        if (crumb)
            headers[crumb.crumbRequestField] = crumb.crumb;
        try {
            await httpPost(`${this.baseUrl}/job/${jobPath(jobName)}/enable`, {
                headers,
            });
            return { jobName, enabled: true };
        }
        catch (e) {
            if (e.message?.includes("HTTP 404"))
                throw Errors.jobNotFound(jobName);
            throw e;
        }
    }
    // Disable a job
    async disableJob(jobName) {
        const crumb = await this.ensureCrumb();
        const headers = this.headers();
        if (crumb)
            headers[crumb.crumbRequestField] = crumb.crumb;
        try {
            await httpPost(`${this.baseUrl}/job/${jobPath(jobName)}/disable`, {
                headers,
            });
            return { jobName, disabled: true };
        }
        catch (e) {
            if (e.message?.includes("HTTP 404"))
                throw Errors.jobNotFound(jobName);
            throw e;
        }
    }
    // Delete a job
    async deleteJob(jobName) {
        const crumb = await this.ensureCrumb();
        const headers = this.headers();
        if (crumb)
            headers[crumb.crumbRequestField] = crumb.crumb;
        try {
            await httpPost(`${this.baseUrl}/job/${jobPath(jobName)}/doDelete`, {
                headers,
            });
            return { jobName, deleted: true };
        }
        catch (e) {
            if (e.message?.includes("HTTP 404"))
                throw Errors.jobNotFound(jobName);
            throw e;
        }
    }
    // Get job configuration (XML)
    async getJobConfig(jobName) {
        try {
            const config = await httpGetText(`${this.baseUrl}/job/${jobPath(jobName)}/config.xml`, { headers: this.headers() });
            return { jobName, config };
        }
        catch (e) {
            if (e.message?.includes("HTTP 404"))
                throw Errors.jobNotFound(jobName);
            throw e;
        }
    }
    // Get parameter definitions for a parameterised job
    async getJobParameters(jobName) {
        try {
            const data = await httpGetJson(`${this.baseUrl}/job/${jobPath(jobName)}/api/json?tree=property[parameterDefinitions[name,type,description,defaultParameterValue[value],choices]]`, { headers: this.headers() });
            const paramProp = (data.property ?? []).find((p) => p._class === "hudson.model.ParametersDefinitionProperty" ||
                Array.isArray(p.parameterDefinitions));
            const defs = paramProp?.parameterDefinitions ?? [];
            const parameters = defs.map((d) => {
                const raw = d.type ?? d._class ?? "";
                const type = raw
                    .replace(/^.*\./, "")
                    .replace(/ParameterDefinition$/, "")
                    .toLowerCase();
                const entry = {
                    name: d.name ?? "",
                    type,
                    description: d.description ?? "",
                    defaultValue: d.defaultParameterValue?.value ?? null,
                };
                if (Array.isArray(d.choices))
                    entry.choices = d.choices;
                return entry;
            });
            return { jobName, parameters };
        }
        catch (e) {
            if (e.message?.includes("HTTP 404"))
                throw Errors.jobNotFound(jobName);
            throw e;
        }
    }
    // List nodes/agents
    async listNodes() {
        try {
            const data = await httpGetJson(`${this.baseUrl}/computer/api/json?depth=1`, { headers: this.headers() });
            if (!data.computer)
                return [];
            return data.computer.map((node) => ({
                name: node.displayName || "",
                offline: node.offline || false,
                idle: node.idle || false,
                numExecutors: node.numExecutors || 0,
                busyExecutors: node.monitorData?.["hudson.node_monitors.SwapSpaceMonitor"]?.availablePhysicalMemory
                    ? 0
                    : node.numExecutors,
                temporarilyOffline: node.temporarilyOffline || false,
                offlineCauseReason: node.offlineCauseReason || "",
            }));
        }
        catch (e) {
            throw e;
        }
    }
    // Get system info
    async getSystemInfo() {
        try {
            const data = await httpGetJson(`${this.baseUrl}/api/json`, {
                headers: this.headers(),
            });
            return {
                nodeDescription: data.nodeDescription || "",
                nodeName: data.nodeName || "",
                numExecutors: data.numExecutors || 0,
                mode: data.mode || "",
                quietingDown: data.quietingDown || false,
                useCrumbs: data.useCrumbs || false,
                useSecurity: data.useSecurity || false,
            };
        }
        catch (e) {
            throw e;
        }
    }
    // Get Jenkins version
    async getVersion() {
        try {
            const res = await fetch(`${this.baseUrl}/api/json`, {
                method: "HEAD",
                headers: this.headers(),
            });
            const version = res.headers.get("x-jenkins") || "unknown";
            return { version };
        }
        catch (e) {
            throw e;
        }
    }
    // Get installed plugins
    async getPlugins() {
        try {
            const data = await httpGetJson(`${this.baseUrl}/pluginManager/api/json?depth=1`, { headers: this.headers() });
            if (!data.plugins)
                return [];
            return data.plugins.map((plugin) => ({
                shortName: plugin.shortName || "",
                longName: plugin.longName || "",
                version: plugin.version || "",
                enabled: plugin.enabled || false,
                active: plugin.active || false,
                hasUpdate: plugin.hasUpdate || false,
            }));
        }
        catch (e) {
            throw e;
        }
    }
    // Get build changes/commits
    async getBuildChanges(jobName, buildNumber) {
        try {
            const data = await httpGetJson(`${this.baseUrl}/job/${jobPath(jobName)}/${buildNumber}/api/json?tree=changeSet[items[author[fullName],msg,commitId,timestamp]]`, { headers: this.headers() });
            if (!data.changeSet || !data.changeSet.items) {
                return { jobName, buildNumber, changes: [] };
            }
            return {
                jobName,
                buildNumber,
                changes: data.changeSet.items.map((change) => ({
                    author: change.author?.fullName || "unknown",
                    message: change.msg || "",
                    commitId: change.commitId || "",
                    timestamp: change.timestamp
                        ? new Date(change.timestamp).toISOString()
                        : null,
                })),
            };
        }
        catch (e) {
            if (e.message?.includes("HTTP 404"))
                throw Errors.jobNotFound(jobName);
            throw e;
        }
    }
    // Get pipeline stages
    async getPipelineStages(jobName, buildNumber) {
        try {
            const data = await httpGetJson(`${this.baseUrl}/job/${jobPath(jobName)}/${buildNumber}/wfapi/describe`, { headers: this.headers() });
            return {
                jobName,
                buildNumber,
                status: data.status || "",
                stages: (data.stages || []).map((stage) => ({
                    id: stage.id || "",
                    name: stage.name || "",
                    status: stage.status || "",
                    startTimeMillis: stage.startTimeMillis || 0,
                    durationMillis: stage.durationMillis || 0,
                    pauseDurationMillis: stage.pauseDurationMillis || 0,
                })),
            };
        }
        catch (e) {
            if (e.message?.includes("HTTP 404")) {
                return {
                    jobName,
                    buildNumber,
                    message: "Not a pipeline build or workflow API not available",
                };
            }
            throw e;
        }
    }
    async createJob(jobName, configXml) {
        const crumb = await this.ensureCrumb();
        const headers = this.headers({
            "Content-Type": "application/xml",
        });
        if (crumb)
            headers[crumb.crumbRequestField] = crumb.crumb;
        const res = await httpPost(`${this.baseUrl}/createItem?name=${encodeURIComponent(jobName)}`, { headers, body: configXml });
        if (res.status >= 400)
            throw Errors.unexpected(`Create job failed: HTTP ${res.status}`);
        return { jobName, created: true };
    }
    async updateJobConfig(jobName, configXml) {
        const crumb = await this.ensureCrumb();
        const headers = this.headers({
            "Content-Type": "application/xml",
        });
        if (crumb)
            headers[crumb.crumbRequestField] = crumb.crumb;
        try {
            await httpPost(`${this.baseUrl}/job/${jobPath(jobName)}/config.xml`, {
                headers,
                body: configXml,
            });
            return { jobName, updated: true };
        }
        catch (e) {
            if (e.message?.includes("HTTP 404"))
                throw Errors.jobNotFound(jobName);
            throw e;
        }
    }
    async renameJob(jobName, newName) {
        const crumb = await this.ensureCrumb();
        const headers = this.headers();
        if (crumb)
            headers[crumb.crumbRequestField] = crumb.crumb;
        try {
            await httpPost(`${this.baseUrl}/job/${jobPath(jobName)}/rename?newName=${encodeURIComponent(newName)}`, { headers });
            return { oldName: jobName, newName, renamed: true };
        }
        catch (e) {
            if (e.message?.includes("HTTP 404"))
                throw Errors.jobNotFound(jobName);
            throw e;
        }
    }
    async copyJob(fromName, newName) {
        const crumb = await this.ensureCrumb();
        const headers = this.headers();
        if (crumb)
            headers[crumb.crumbRequestField] = crumb.crumb;
        try {
            const res = await httpPost(`${this.baseUrl}/createItem?name=${encodeURIComponent(newName)}&from=${encodeURIComponent(fromName)}&mode=copy`, { headers });
            if (res.status >= 400)
                throw Errors.unexpected(`Copy job failed: HTTP ${res.status}`);
            return { fromName, newName, copied: true };
        }
        catch (e) {
            if (e.message?.includes("HTTP 404"))
                throw Errors.jobNotFound(fromName);
            throw e;
        }
    }
    async getNode(nodeName) {
        try {
            const data = await httpGetJson(`${this.baseUrl}/computer/${encodeURIComponent(nodeName)}/api/json?depth=1`, { headers: this.headers() });
            return {
                name: data.displayName || nodeName,
                offline: data.offline || false,
                temporarilyOffline: data.temporarilyOffline || false,
                offlineCauseReason: data.offlineCauseReason || "",
                idle: data.idle || false,
                numExecutors: data.numExecutors || 0,
                assignedLabels: (data.assignedLabels || []).map((l) => l.name),
                monitorData: data.monitorData || {},
            };
        }
        catch (e) {
            if (e.message?.includes("HTTP 404"))
                throw new McpError("NODE_NOT_FOUND", `Node not found: ${nodeName}`, 404);
            throw e;
        }
    }
    async toggleNodeOffline(nodeName, offlineMessage = "") {
        const crumb = await this.ensureCrumb();
        const headers = this.headers();
        if (crumb)
            headers[crumb.crumbRequestField] = crumb.crumb;
        try {
            await httpPost(`${this.baseUrl}/computer/${encodeURIComponent(nodeName)}/toggleOffline?offlineMessage=${encodeURIComponent(offlineMessage)}`, { headers });
            return { nodeName, toggledOffline: true };
        }
        catch (e) {
            if (e.message?.includes("HTTP 404"))
                throw new McpError("NODE_NOT_FOUND", `Node not found: ${nodeName}`, 404);
            throw e;
        }
    }
    async listViews() {
        const data = await httpGetJson(`${this.baseUrl}/api/json?tree=views[name,url,jobs[name,url]]`, { headers: this.headers() });
        if (!Array.isArray(data.views))
            return [];
        return data.views.map((v) => ({
            name: v.name || "",
            url: v.url || "",
            jobs: (v.jobs || []).map((j) => ({ name: j.name, url: j.url })),
        }));
    }
    async getView(viewName) {
        try {
            const data = await httpGetJson(`${this.baseUrl}/view/${encodeURIComponent(viewName)}/api/json`, { headers: this.headers() });
            return {
                name: data.name || viewName,
                url: data.url || "",
                description: data.description || "",
                jobs: (data.jobs || []).map((j) => ({
                    name: j.name,
                    url: j.url,
                    color: j.color,
                })),
            };
        }
        catch (e) {
            if (e.message?.includes("HTTP 404"))
                throw new McpError("VIEW_NOT_FOUND", `View not found: ${viewName}`, 404);
            throw e;
        }
    }
    async quietDown(reason = "") {
        const crumb = await this.ensureCrumb();
        const headers = this.headers();
        if (crumb)
            headers[crumb.crumbRequestField] = crumb.crumb;
        const url = reason
            ? `${this.baseUrl}/quietDown?reason=${encodeURIComponent(reason)}`
            : `${this.baseUrl}/quietDown`;
        await httpPost(url, { headers });
        return { quietingDown: true };
    }
    async cancelQuietDown() {
        const crumb = await this.ensureCrumb();
        const headers = this.headers();
        if (crumb)
            headers[crumb.crumbRequestField] = crumb.crumb;
        await httpPost(`${this.baseUrl}/cancelQuietDown`, { headers });
        return { quietingDown: false };
    }
    async safeRestart() {
        const crumb = await this.ensureCrumb();
        const headers = this.headers();
        if (crumb)
            headers[crumb.crumbRequestField] = crumb.crumb;
        await httpPost(`${this.baseUrl}/safeRestart`, { headers });
        return { restarting: true };
    }
    // Replay build (for pipeline jobs)
    async replayBuild(jobName, buildNumber, mainScript) {
        const crumb = await this.ensureCrumb();
        const headers = this.headers();
        if (crumb)
            headers[crumb.crumbRequestField] = crumb.crumb;
        const init = { headers };
        if (mainScript !== undefined) {
            headers["Content-Type"] = "application/x-www-form-urlencoded";
            init.body = new URLSearchParams({ mainScript }).toString();
        }
        const res = await httpPost(`${this.baseUrl}/job/${jobPath(jobName)}/${buildNumber}/replay/rebuild`, init);
        if (res.status === 404)
            throw Errors.jobNotFound(jobName);
        if (res.status >= 400)
            throw Errors.unexpected(`Replay failed with status ${res.status}`);
        return { jobName, buildNumber, queueUrl: res.headers["location"] || null };
    }
}
export const createClient = () => new JenkinsClient();
//# sourceMappingURL=jenkins-client.js.map