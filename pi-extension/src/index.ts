import type { ExtensionAPI, ProviderConfig, ProviderModelConfig } from "@earendil-works/pi-coding-agent"

/**
 * nano-llm provider extension for Pi.
 *
 * Registers an OpenAI-compatible provider (`api: "openai-completions"`), so
 * request conversion, streaming, tool handling, usage accounting and
 * cancellation are all delegated to Pi's built-in implementation - no custom
 * `streamSimple` needed.
 *
 * The model list is discovered dynamically: `refreshModels` hits
 * `GET {baseUrl}/models` (Bearer auth) and returns the resulting list, which
 * replaces the extension-provided models for this provider.
 *
 * Config is read from the environment at load time:
 *   NANO_LLM_BASE_URL   override the endpoint (default https://<your-nano-llm-endpoint>/v1)
 *   NANO_LLM_API_KEY    the API key (referenced as $NANO_LLM_API_KEY by Pi itself)
 *   NANO_LLM_API_KEY_ENV  name of a different env var holding the key
 *
 * See https://pi.dev/docs/latest/custom-provider for the surrounding contract.
 */

const PROVIDER_ID = "nano-llm"
const PROVIDER_NAME = "Nano LLM"
const DEFAULT_BASE_URL = "https://<your-nano-llm-endpoint>/v1"
const DEFAULT_API_KEY_ENV = "NANO_LLM_API_KEY"

const DEFAULT_CONTEXT_WINDOW = 128_000
const DEFAULT_MAX_TOKENS = 8_192
const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }

/** Used until live discovery succeeds, so the provider is never empty. */
const FALLBACK_MODEL_IDS: readonly string[] = ["kilo/liquid/lfm-2.5-2.6b:free-66K-txt"]

type RemoteModel = {
  id?: unknown
  name?: unknown
  context_length?: unknown
  context_window?: unknown
  max_tokens?: unknown
}

type ModelsPayload = { data?: RemoteModel[]; models?: RemoteModel[] }

type DiscoverOptions = {
  signal?: AbortSignal
  headers?: Record<string, string>
  /** Marks discovered models as reasoning-capable. `/models` cannot tell us. */
  reasoning?: boolean
}

function normaliseBaseURL(baseURL: string): string {
  return baseURL.replace(/\/+$/, "")
}

function readPositiveInt(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return undefined
  return Math.floor(value)
}

function fallbackModels(reasoning: boolean): ProviderModelConfig[] {
  return FALLBACK_MODEL_IDS.map((id) => ({
    id,
    name: id,
    reasoning,
    input: ["text"] as ("text" | "image")[],
    cost: ZERO_COST,
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    maxTokens: DEFAULT_MAX_TOKENS,
  }))
}

async function discoverModels(baseURL: string, options: DiscoverOptions = {}): Promise<ProviderModelConfig[]> {
  const url = `${normaliseBaseURL(baseURL)}/models`
  const reasoning = options.reasoning ?? false

  const response = await fetch(url, { headers: options.headers, signal: options.signal })
  if (!response.ok) {
    throw new Error(`nano-llm: GET ${url} failed with ${response.status} ${response.statusText}`)
  }

  const payload = (await response.json()) as ModelsPayload
  const entries = payload.data ?? payload.models ?? []

  const models: ProviderModelConfig[] = []
  for (const entry of entries) {
    if (typeof entry?.id !== "string" || entry.id.length === 0) continue
    models.push({
      id: entry.id,
      name: typeof entry.name === "string" && entry.name.length > 0 ? entry.name : entry.id,
      reasoning,
      input: ["text"] as ("text" | "image")[],
      cost: ZERO_COST,
      contextWindow:
        readPositiveInt(entry.context_length) ?? readPositiveInt(entry.context_window) ?? DEFAULT_CONTEXT_WINDOW,
      maxTokens: readPositiveInt(entry.max_tokens) ?? DEFAULT_MAX_TOKENS,
    })
  }

  return models
}

export default function nanoLLM(pi: ExtensionAPI): void {
  const baseURL = normaliseBaseURL(process.env.NANO_LLM_BASE_URL ?? DEFAULT_BASE_URL)
  const apiKeyEnv = process.env.NANO_LLM_API_KEY_ENV ?? DEFAULT_API_KEY_ENV
  const apiKey = process.env[apiKeyEnv]

  const authHeaders: Record<string, string> = apiKey ? { authorization: `Bearer ${apiKey}` } : {}

  const config: ProviderConfig = {
    name: PROVIDER_NAME,
    baseUrl: baseURL,
    // $(ENV) syntax: Pi resolves the key at request time instead of us baking
    // the secret into the registered provider.
    apiKey: `$${apiKeyEnv}`,
    api: "openai-completions",
    // Adds `Authorization: Bearer <resolved api key>` to provider requests.
    authHeader: true,
    models: fallbackModels(false),
    refreshModels: async (context) => {
      if (!context.allowNetwork) return fallbackModels(false)

      try {
        return await discoverModels(context.baseUrl ?? baseURL, {
          signal: context.signal,
          headers: authHeaders,
        })
      } catch (error) {
        // Keep the previous/fallback list rather than losing the provider.
        console.error(
          `[nano-llm] model discovery failed: ${error instanceof Error ? error.message : String(error)}`,
        )
        return fallbackModels(false)
      }
    },
  }

  pi.registerProvider(PROVIDER_ID, config)
}
