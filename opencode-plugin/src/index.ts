import { Model, Plugin, Provider } from "@opencode/plugin"

/**
 * nano-llm provider plugin for OpenCode V2.
 *
 * Contributes two things:
 *
 * 1. An integration (`nano-llm`) with an API-key method plus an environment
 *    method, so the TUI `/connect` flow can collect and store the key.
 * 2. An OpenAI-compatible provider whose models are discovered at runtime from
 *    `GET {baseURL}/models`.
 *
 * Both are published through transforms, which are synchronous and replayed
 * onto fresh registry state on every registration/removal/reload. External data
 * (the resolved credential and the discovered model list) is therefore captured
 * into `source` *before* the transform callbacks run, and `ctx.provider.reload()`
 * is called whenever that captured data changes.
 */

const PROVIDER_ID = Provider.ID.make("nano-llm")
const INTEGRATION_ID = "nano-llm"
const PROVIDER_NAME = "Nano LLM"
const INTEGRATION_NAME = "Nano LLM"
const PROVIDER_PACKAGE = "@opencode/ai/providers/openai-compatible"
const DEFAULT_BASE_URL = "https://<your-nano-llm-endpoint>/v1"
const DEFAULT_API_KEY_ENV = "NANO_LLM_API_KEY"
const DEFAULT_MODEL_ID = "kilo/liquid/lfm-2.5-2.6b:free-66K-txt"

export type NanoLLMOptions = {
  /** OpenAI-compatible base URL. Defaults to https://<your-nano-llm-endpoint>/v1 */
  baseURL?: string
  /** Literal API key. Takes precedence over a stored credential and the environment. */
  apiKey?: string
  /** Environment variable holding the API key. Defaults to NANO_LLM_API_KEY */
  apiKeyEnv?: string
  /** Discovery refresh interval in ms. Disabled when unset or 0. */
  refreshIntervalMs?: number
  /** Used until (or if) live discovery succeeds. */
  fallbackModels?: ReadonlyArray<ModelSeed>
}

type ModelSeed = { id: string; name?: string }

type SetupContext = Plugin.Context
type ConnectionInfo = Awaited<ReturnType<SetupContext["integration"]["connection"]["active"]>>
type CredentialValue = Awaited<ReturnType<SetupContext["integration"]["connection"]["resolve"]>>

/** Captured external state read by the (replayable) transforms below. */
type Source = {
  models: readonly ModelSeed[]
  apiKey?: string
  connection?: ConnectionInfo
  error?: string
}

function resolveBaseURL(baseURL: string): string {
  return baseURL.replace(/\/+$/, "")
}

function credentialKey(value: CredentialValue): string | undefined {
  if (!value) return undefined
  if (value.type === "key") return value.key
  if (value.type === "oauth") return value.access
  return undefined
}

async function fetchModels(baseURL: string, apiKey: string | undefined): Promise<ModelSeed[]> {
  const url = `${resolveBaseURL(baseURL)}/models`
  const response = await fetch(url, {
    headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {},
  })

  if (!response.ok) {
    throw new Error(`GET ${url} failed with ${response.status} ${response.statusText}`)
  }

  const payload = (await response.json()) as {
    data?: Array<{ id?: unknown; name?: unknown }>
    models?: Array<{ id?: unknown; name?: unknown }>
  }

  const seeds: ModelSeed[] = []
  for (const entry of payload.data ?? payload.models ?? []) {
    if (typeof entry?.id !== "string" || entry.id.length === 0) continue
    seeds.push({ id: entry.id, name: typeof entry.name === "string" ? entry.name : undefined })
  }
  return seeds
}

function toModelInfo(seed: ModelSeed): Model.Info {
  return {
    ...Model.Info.default(PROVIDER_ID, Model.ID.make(seed.id)),
    name: seed.name ?? seed.id,
  }
}

export default Plugin.define({
  id: "nano-llm",
  async setup(ctx) {
    const options = (ctx.options ?? {}) as NanoLLMOptions

    const baseURL = resolveBaseURL(options.baseURL ?? process.env.NANO_LLM_BASE_URL ?? DEFAULT_BASE_URL)
    const apiKeyEnv = options.apiKeyEnv ?? DEFAULT_API_KEY_ENV

    const source: Source = {
      models: options.fallbackModels ?? [{ id: DEFAULT_MODEL_ID, name: "Nano LLM Chat" }],
    }

    // 1. Integration + auth methods. Two transforms so the second one can see
    // the integration created by the first during replay.
    await ctx.integration.transform((editor) => {
      editor.method.update({
        integrationID: INTEGRATION_ID,
        method: { type: "key", label: "Nano LLM API key" },
      })
      editor.method.update({
        integrationID: INTEGRATION_ID,
        method: { type: "env", names: [apiKeyEnv] },
      })
    })

    await ctx.integration.transform((editor) => {
      if (!editor.get(INTEGRATION_ID)) return
      editor.update(INTEGRATION_ID, (integration) => {
        integration.name = INTEGRATION_NAME
      })
    })

    /** Resolve the active account for the integration, then its credential. */
    const resolveCredential = async () => {
      const connection = await ctx.integration.connection.active(INTEGRATION_ID)
      if (!connection) return { connection: undefined, value: undefined }
      const value = await ctx.integration.connection.resolve(connection)
      return { connection, value }
    }

    /** Re-resolve credentials, rediscover models, then let OpenCode replay. */
    const refresh = async () => {
      try {
        const { connection, value } = await resolveCredential()
        const apiKey = options.apiKey ?? credentialKey(value) ?? process.env[apiKeyEnv]
        source.apiKey = apiKey
        source.connection = connection

        try {
          source.models = await fetchModels(baseURL, apiKey)
          source.error = undefined
        } catch (error) {
          source.error = error instanceof Error ? error.message : String(error)
          console.error(
            `[nano-llm] ${source.error} (retaining ${source.models.length} known model(s); connect an API key with /connect)`,
          )
        }
      } catch (error) {
        console.error(
          `[nano-llm] credential lookup failed: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
      await ctx.provider.reload()
    }

    await refresh()

    // 2. Provider contribution. Closes over `source`, so a reload replays it
    // against the freshly captured credential + model inventory.
    await ctx.provider.transform((editor) => {
      if (editor.get(PROVIDER_ID)) editor.remove(PROVIDER_ID)
      editor.add({
        info: {
          ...Provider.Info.empty(PROVIDER_ID),
          name: PROVIDER_NAME,
          activation: "enabled",
          package: PROVIDER_PACKAGE,
          integrationID: INTEGRATION_ID as NonNullable<Provider.Info["integrationID"]>,
          settings: {
            baseURL,
            ...(source.apiKey ? { apiKey: source.apiKey } : {}),
          },
        },
        models: source.models.map(toModelInfo),
        ...(source.connection ? { sourceConnection: source.connection } : {}),
      })
    })

    // 3. React to /connect, account switches, and logouts.
    const abort = new AbortController()
    void (async () => {
      try {
        const events = ctx.event.subscribe({ signal: abort.signal }) as AsyncIterable<{ type?: string }>
        for await (const event of events) {
          const type = event?.type
          if (typeof type !== "string") continue
          if (!type.startsWith("credential.") && !type.startsWith("integration.")) continue
          await refresh()
        }
      } catch (error) {
        if (abort.signal.aborted) return
        console.error(
          `[nano-llm] event stream stopped: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
    })()

    const refreshIntervalMs = options.refreshIntervalMs ?? 0
    const timer = refreshIntervalMs > 0 ? setInterval(() => void refresh(), refreshIntervalMs) : undefined

    return () => {
      abort.abort()
      if (timer) clearInterval(timer)
    }
  },
})
