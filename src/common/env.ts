export interface JenkinsEnv {
  JENKINS_URL: string
  JENKINS_USER?: string
  JENKINS_API_TOKEN?: string
  JENKINS_BEARER_TOKEN?: string
}

export interface CliArgs {
  jenkinsUrl?: string
  jenkinsUser?: string
  jenkinsApiToken?: string
  jenkinsBearerToken?: string
}

// Store resolved configs globally to avoid re-parsing
let cachedInstances: Map<string, JenkinsEnv> | null = null

/**
 * Get a configuration value with priority:
 * 1. CLI argument (highest priority)
 * 2. MCP_JENKINS_* environment variable (medium priority)
 * 3. JENKINS_* environment variable (lowest priority)
 */
const getConfigValue = (
  cliValue: string | undefined,
  mcpEnvKey: string,
  jenkinsEnvKey: string,
): string | undefined => {
  if (cliValue !== undefined) return cliValue
  const mcpValue = process.env[mcpEnvKey]
  if (mcpValue !== undefined) return mcpValue
  return process.env[jenkinsEnvKey]
}

const splitValues = (value: string | undefined): string[] =>
  value ? value.split(/[,|]/).map((v) => v.trim()) : []

const buildInstanceEnv = (
  url: string,
  user: string | undefined,
  apiToken: string | undefined,
  bearerToken: string | undefined,
): JenkinsEnv => {
  const hasBasicAuth = user && apiToken
  const hasBearerAuth = bearerToken

  if (!hasBasicAuth && !hasBearerAuth) {
    throw new Error(
      `Missing Jenkins authentication for URL ${url}. Provide via:\n` +
        "  Bearer Token:\n" +
        "    1. CLI: --jenkins-bearer-token <token>\n" +
        "    2. Environment: MCP_JENKINS_BEARER_TOKEN=<token>\n" +
        "    3. Environment: JENKINS_BEARER_TOKEN=<token>\n" +
        "  OR Basic Auth:\n" +
        "    1. CLI: --jenkins-user <user> --jenkins-api-token <token>\n" +
        "    2. Environment: MCP_JENKINS_USER=<user> MCP_JENKINS_API_TOKEN=<token>\n" +
        "    3. Environment: JENKINS_USER=<user> JENKINS_API_TOKEN=<token>",
    )
  }

  return {
    JENKINS_URL: url.replace(/\/$/, ""),
    JENKINS_USER: user || undefined,
    JENKINS_API_TOKEN: apiToken || undefined,
    JENKINS_BEARER_TOKEN: bearerToken || undefined,
  }
}

/**
 * Load all named Jenkins instances from environment variables.
 *
 * Single instance (backwards compat):
 *   MCP_JENKINS_URL=https://jenkins.example.com
 *   MCP_JENKINS_USER=admin
 *   MCP_JENKINS_API_TOKEN=token
 *
 * Multiple instances (comma or pipe separated, positional):
 *   MCP_JENKINS_INSTANCES=pipeline,scheduler
 *   MCP_JENKINS_URL=https://pipeline.example.com,https://scheduler.example.com
 *   MCP_JENKINS_USER=admin,admin
 *   MCP_JENKINS_API_TOKEN=token1,token2
 *
 * The first instance is always the default (used when no instance param is provided).
 */
export const loadAllJenkinsInstances = (
  cliArgs?: CliArgs,
): Map<string, JenkinsEnv> => {
  if (cachedInstances && !cliArgs) return cachedInstances

  const rawUrl = getConfigValue(
    cliArgs?.jenkinsUrl,
    "MCP_JENKINS_URL",
    "JENKINS_URL",
  )
  const rawUser = getConfigValue(
    cliArgs?.jenkinsUser,
    "MCP_JENKINS_USER",
    "JENKINS_USER",
  )
  const rawApiToken = getConfigValue(
    cliArgs?.jenkinsApiToken,
    "MCP_JENKINS_API_TOKEN",
    "JENKINS_API_TOKEN",
  )
  const rawBearerToken = getConfigValue(
    cliArgs?.jenkinsBearerToken,
    "MCP_JENKINS_BEARER_TOKEN",
    "JENKINS_BEARER_TOKEN",
  )
  const rawInstances = process.env["MCP_JENKINS_INSTANCES"]

  if (!rawUrl) {
    throw new Error(
      "Missing JENKINS_URL. Provide via:\n" +
        "  1. CLI: --jenkins-url <url>\n" +
        "  2. Environment: MCP_JENKINS_URL=<url>\n" +
        "  3. Environment: JENKINS_URL=<url>",
    )
  }

  const urls = splitValues(rawUrl)
  const users = splitValues(rawUser)
  const apiTokens = splitValues(rawApiToken)
  const bearerTokens = splitValues(rawBearerToken)
  const instanceNames = rawInstances
    ? splitValues(rawInstances)
    : urls.map((url) => new URL(url).hostname.split(".")[0])

  if (urls.length !== instanceNames.length) {
    throw new Error(
      `MCP_JENKINS_INSTANCES has ${instanceNames.length} names but MCP_JENKINS_URL has ${urls.length} values — counts must match`,
    )
  }

  const instances = new Map<string, JenkinsEnv>()

  for (let i = 0; i < urls.length; i++) {
    const name = instanceNames[i]
    const url = urls[i]
    const user = users[i] ?? users[0]
    const apiToken = apiTokens[i] ?? apiTokens[0]
    const bearerToken = bearerTokens[i] ?? bearerTokens[0]
    instances.set(name, buildInstanceEnv(url, user, apiToken, bearerToken))
  }

  if (cliArgs) cachedInstances = instances
  return instances
}

/** Returns the single (first) Jenkins instance — backwards-compatible helper. */
export const loadJenkinsEnv = (cliArgs?: CliArgs): JenkinsEnv => {
  const instances = loadAllJenkinsInstances(cliArgs)
  return instances.values().next().value as JenkinsEnv
}

/** Returns instance names available at startup (for tool schema description). */
export const getInstanceNames = (): string[] => {
  if (!cachedInstances) return []
  return Array.from(cachedInstances.keys())
}
