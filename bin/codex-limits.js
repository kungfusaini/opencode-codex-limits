#!/usr/bin/env node

import { formatCodexLimits, getCodexLimitsSummary, sanitize } from "../src/codex-limits.js"

const jsonMode = process.argv.includes("--json")

try {
  const summary = await getCodexLimitsSummary()
  if (jsonMode) {
    console.log(JSON.stringify(summary, null, 2))
  } else {
    console.log(formatCodexLimits(summary))
  }
} catch (error) {
  if (jsonMode) {
    console.log(JSON.stringify({ ok: false, error: error.message, detail: error.detail }, null, 2))
  } else {
    console.error(`Codex limits unavailable: ${error.message}`)
    if (error.detail) console.error(sanitize(error.detail))
  }
  process.exit(1)
}
