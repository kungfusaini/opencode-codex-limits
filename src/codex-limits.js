import fs from "node:fs"
import os from "node:os"
import path from "node:path"

export const AUTH_PATH = path.join(os.homedir(), ".local/share/opencode/auth.json")
export const TOKEN_URL = "https://auth.openai.com/oauth/token"
export const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage"

// OpenAI's Codex CLI OAuth client id. This plugin only uses an existing
// OpenCode OpenAI OAuth login and refreshes that local credential if needed.
const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"

export class CodexLimitsError extends Error {
  constructor(message, detail) {
    super(message)
    this.name = "CodexLimitsError"
    this.detail = detail
  }
}

export function sanitize(text) {
  return String(text || "")
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "[redacted-token]")
    .replace(/\bsk-[A-Za-z0-9][A-Za-z0-9._:-]{19,}\b/gi, "[redacted-token]")
    .slice(0, 500)
}

function readAuthFile() {
  if (!fs.existsSync(AUTH_PATH)) {
    throw new CodexLimitsError(`auth file not found at ${AUTH_PATH}`)
  }

  try {
    return JSON.parse(fs.readFileSync(AUTH_PATH, "utf8"))
  } catch (error) {
    throw new CodexLimitsError(`could not parse ${AUTH_PATH}`, error.message)
  }
}

function writeAuthFile(authFile) {
  const tmp = `${AUTH_PATH}.${process.pid}.tmp`
  fs.writeFileSync(tmp, `${JSON.stringify(authFile, null, 2)}\n`, { mode: 0o600 })
  fs.renameSync(tmp, AUTH_PATH)
}

function decodeJwt(token) {
  try {
    const [, payload] = token.split(".")
    if (!payload) return null
    return JSON.parse(Buffer.from(payload, "base64url").toString("utf8"))
  } catch {
    return null
  }
}

async function safeBody(response) {
  try {
    return await response.text()
  } catch {
    return ""
  }
}

async function refreshAccessToken(authFile, auth) {
  if (!auth.refresh) throw new CodexLimitsError("OpenAI OAuth refresh token is missing")

  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: auth.refresh,
      client_id: CLIENT_ID,
    }),
  })

  if (!response.ok) {
    const body = await safeBody(response)
    throw new CodexLimitsError(`token refresh failed with HTTP ${response.status}`, sanitize(body))
  }

  const payload = await response.json()
  if (!payload.access_token || !payload.refresh_token || typeof payload.expires_in !== "number") {
    throw new CodexLimitsError("token refresh response did not include expected OAuth fields")
  }

  auth.access = payload.access_token
  auth.refresh = payload.refresh_token
  auth.expires = Date.now() + payload.expires_in * 1000
  if (payload.id_token) auth.idToken = payload.id_token

  writeAuthFile(authFile)
  return auth
}

function accountIdFrom(auth) {
  return (
    auth.accountIdOverride ||
    decodeJwt(auth.access)?.["https://api.openai.com/auth"]?.chatgpt_account_id ||
    decodeJwt(auth.idToken || "")?.["https://api.openai.com/auth"]?.chatgpt_account_id
  )
}

async function fetchUsage(auth) {
  const accountId = accountIdFrom(auth)
  if (!accountId) {
    throw new CodexLimitsError("could not determine ChatGPT account id from OpenAI OAuth token")
  }

  const headers = {
    Authorization: `Bearer ${auth.access}`,
    "ChatGPT-Account-Id": accountId,
    originator: "codex_cli_rs",
    accept: "application/json",
    "User-Agent": "codex-cli",
  }

  if (auth.organizationIdOverride) {
    headers["OpenAI-Organization"] = auth.organizationIdOverride
  }

  const response = await fetch(USAGE_URL, { headers })
  if (!response.ok) {
    const body = await safeBody(response)
    throw new CodexLimitsError(`usage request failed with HTTP ${response.status}`, sanitize(body))
  }

  return await response.json()
}

function numberOrNull(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null
}

function mapWindow(window) {
  if (!window) return null
  const usedPercent = numberOrNull(window.used_percent)
  const leftPercent = usedPercent === null ? null : Math.max(0, Math.round(100 - usedPercent))
  const windowSeconds = numberOrNull(window.limit_window_seconds)
  const resetAtSeconds = numberOrNull(window.reset_at)
  const resetAfterSeconds = numberOrNull(window.reset_after_seconds)
  const resetAtMs = resetAtSeconds
    ? resetAtSeconds * 1000
    : resetAfterSeconds
      ? Date.now() + resetAfterSeconds * 1000
      : null

  return {
    usedPercent,
    leftPercent,
    windowSeconds,
    windowMinutes: windowSeconds ? Math.ceil(windowSeconds / 60) : null,
    resetAtMs,
  }
}

function limitName(window, fallback) {
  if (window?.windowMinutes === 300) return "5h limit"
  if (window?.windowMinutes === 10080) return "Weekly limit"
  return fallback
}

function summarize(payload) {
  const primary = mapWindow(payload.rate_limit?.primary_window)
  const secondary = mapWindow(payload.rate_limit?.secondary_window)
  return {
    ok: true,
    limits: [
      primary ? { name: limitName(primary, "Primary limit"), ...primary } : null,
      secondary ? { name: limitName(secondary, "Secondary limit"), ...secondary } : null,
    ],
  }
}

export async function getCodexLimitsSummary() {
  const authFile = readAuthFile()
  let auth = authFile.openai
  if (!auth || auth.type !== "oauth") {
    throw new CodexLimitsError("OpenAI OAuth credentials are not configured; run `opencode auth login` for OpenAI")
  }

  if (!auth.access || !auth.expires || auth.expires <= Date.now() + 60_000) {
    auth = await refreshAccessToken(authFile, auth)
  }

  return summarize(await fetchUsage(auth))
}

function bar(leftPercent) {
  const width = 20
  const left = Number.isFinite(leftPercent) ? Math.max(0, Math.min(100, leftPercent)) : 0
  const filled = Math.round((left / 100) * width)
  return `${"█".repeat(filled)}${"░".repeat(width - filled)}`
}

function formatReset(resetAtMs) {
  if (!resetAtMs) return "reset unknown"
  const when = new Date(resetAtMs).toLocaleString(undefined, {
    weekday: "short",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  })
  const deltaMs = resetAtMs - Date.now()
  if (deltaMs <= 0) return `resets now\n${when}`

  const minutes = Math.round(deltaMs / 60000)
  if (minutes < 60) return `resets in ${minutes}m\n${when}`

  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  if (hours < 24) return `resets in ${hours}h ${rest}m\n${when}`

  const days = Math.floor(hours / 24)
  const dayHours = hours % 24
  return `resets in ${days}d ${dayHours}h\n${when}`
}

function lineFor(limit) {
  const left = Number.isFinite(limit?.leftPercent) ? limit.leftPercent : 0
  const used = Number.isFinite(limit?.usedPercent) ? limit.usedPercent : 100 - left
  return [
    `${limit?.name ?? "Limit"}`,
    `[${bar(left)}]`,
    `${left}% left · ${used}% used`,
    formatReset(limit?.resetAtMs),
  ].join("\n")
}

export function formatCodexLimits(summary) {
  const fiveHour = summary.limits?.find((limit) => limit?.windowMinutes === 300)
  const weekly = summary.limits?.find((limit) => limit?.windowMinutes === 10080)

  return [lineFor(fiveHour), "", lineFor(weekly)].join("\n")
}
