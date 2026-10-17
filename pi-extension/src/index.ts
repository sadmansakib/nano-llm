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
 * Config:
 *   NANO_LLM_BASE_URL   endpoint (required — set here or `baseUrl` in ~/.pi/agent/models.json)
 *   API key: read from Pi's stored auth.json credential — no env var needed.
 *
 * See https://pi.dev/docs/latest/custom-provider for the surrounding contract.
 */

const PROVIDER_ID = "nano-llm"
const PROVIDER_NAME = "Nano LLM"

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
function authHeadersFromCredential(credential: unknown): Record<string, string> {
  const key =
    credential && typeof credential === "object" && (credential as { type?: string }).type === "api_key"
      ? (credential as { key?: string }).key
      : undefined
  return key ? { authorization: `Bearer ${key}` } : {}
}

export default function nanoLLM(pi: ExtensionAPI): void {
  const rawBaseURL = process.env.NANO_LLM_BASE_URL
  if (!rawBaseURL) {
    throw new Error(
      "[nano-llm] no base URL configured. Set NANO_LLM_BASE_URL in the environment, or `baseUrl` for the nano-llm provider in ~/.pi/agent/models.json.",
    )
  }
  const baseURL = normaliseBaseURL(rawBaseURL)
  const config: ProviderConfig = {
    name: PROVIDER_NAME,
    baseUrl: baseURL,
    // Key lives in auth.json (via /login or manual edit). This field is a
    // required declaration only; Pi prefers the stored auth.json credential
    // over resolving this from the environment.
    apiKey: "$NANO_LLM_API_KEY",
    api: "openai-completions",
    // Adds `Authorization: Bearer <resolved api key>` to provider requests.
    authHeader: true,
    models: fallbackModels(false),
    refreshModels: async (context) => {
      if (!context.allowNetwork) return fallbackModels(false)

      try {
        return await discoverModels(context.baseUrl ?? baseURL, {
          signal: context.signal,
          headers: authHeadersFromCredential(context.credential),
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
