import { formatCodexLimits, getCodexLimitsSummary, sanitize } from "./codex-limits.js"

function sanitizeError(error) {
  const text = [error?.message, error?.detail, error?.stdout, error?.stderr].filter(Boolean).join("\n").trim()
  return sanitize(text || "Unknown error.")
}

function showAlert(api, title, message) {
  api.ui.dialog.replace(() =>
    api.ui.DialogAlert({
      title,
      message,
      onConfirm: () => api.ui.dialog.clear(),
    }),
  )
}

async function showCodexLimits(api) {
  showAlert(api, "Codex limits", "Loading Codex limits…")

  try {
    const summary = await getCodexLimitsSummary()
    showAlert(api, "Codex limits", formatCodexLimits(summary))
  } catch (error) {
    showAlert(api, "Codex limits unavailable", sanitizeError(error))
  }
}

export default {
  id: "opencode-codex-limits",
  async tui(api) {
    const dispose = api.command?.register(() => [
      {
        title: "Codex limits",
        value: "codex-limits.show",
        description: "Show current Codex 5h and weekly usage in a dialog.",
        category: "Codex",
        slash: {
          name: "limits",
          aliases: ["codex-limits"],
        },
        onSelect: () => showCodexLimits(api),
      },
    ])

    if (dispose) api.lifecycle.onDispose(dispose)
  },
}
