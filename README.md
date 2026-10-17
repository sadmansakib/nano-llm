# nano-llm

Provider integrations for the **nano-llm** OpenAI-compatible endpoint, for two hosts:

| Host | Integration | Discovery |
| --- | --- | --- |
| [OpenCode V2](https://opencode.ai/v2/docs/) | `opencode-plugin/` — plugin using `ctx.provider.transform` | dynamic, `ctx.provider.reload()` |
| [Pi](https://pi.dev/docs/latest/) | `pi-extension/` — extension using `pi.registerProvider` | dynamic, `refreshModels` |

Endpoint: `<your-nano-llm-endpoint>/v1` — OpenAI-compatible, requires a Bearer API key.

```
nano-llm/
├── opencode-plugin/       # OpenCode V2 provider plugin (TypeScript)
│   └── src/index.ts
├── pi-extension/          # Pi provider extension (TypeScript, no build step)
│   └── src/index.ts
└── examples/
    ├── opencode.jsonc     # declarative OpenCode config (no plugin)
    └── pi-models.json     # static Pi models.json (no extension)
```

## Setup

```sh
bun install
bun run typecheck
cp .env.example .env   # then edit, or export NANO_LLM_API_KEY directly
```

The API key is never committed. Both integrations resolve it from the environment.

## Environment

| Variable | Default | Used by |
| --- | --- | --- |
| `NANO_LLM_API_KEY` | — | both |
| `NANO_LLM_BASE_URL` | required, no default (self-hosting supported) | both |
| `NANO_LLM_API_KEY_ENV` | `NANO_LLM_API_KEY` | both (name of the var holding the key) |

## Install

**OpenCode V2:**

```sh
opencode plugin add nano-llm-opencode-plugin
```

**Pi:**

```sh
pi install npm:nano-llm-pi-extension
```

Set `NANO_LLM_API_KEY` in your shell. OpenCode also supports `/connect` → *Nano LLM* → *login with API key*, which stores the credential and takes precedence over the environment.
## OpenCode V2

Two routes; both are supported here.

### A. Plugin (runtime discovery)

Add to `opencode.jsonc` (project or `~/.config/opencode/`):

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "nano-llm-opencode-plugin",
      "options": {
        "baseURL": "<your-nano-llm-endpoint>/v1",
        "apiKeyEnv": "NANO_LLM_API_KEY",
        "refreshIntervalMs": 900000
      }
    }
  ]
}
```

The plugin registers the provider through `ctx.provider.transform` and discovers
models from `GET {baseURL}/models` at startup. `refreshIntervalMs` (optional)
re-fetches the list and calls `ctx.provider.reload()`, which makes OpenCode
replay the transform against the new data. Leave it unset to discover once.

`fallbackModels: [{ id: "..." }]` seeds the list if discovery fails.

### B. Declarative config (no code)

See `examples/opencode.jsonc`:

```jsonc
{
  "providers": {
    "nano-llm": {
      "name": "Nano LLM",
      "package": "@opencode/ai/providers/openai-compatible",
      "settings": {
        "baseURL": "<your-nano-llm-endpoint>/v1",
        "apiKey": "{env:NANO_LLM_API_KEY}"
      },
      "models": { "kilo/liquid/lfm-2.5-2.6b:free-66K-txt": { "name": "LFM 2.5 (fallback)" } }
    }
  }
}
```

`settings` accepts arbitrary package options in addition to the typed ones
(`timeout`, `headerTimeout`, `chunkTimeout`, `transport`, `compaction`,
`encoding`), which is why `baseURL`/`apiKey` live there.

## Pi

### A. Extension (runtime discovery)

```sh
NANO_LLM_API_KEY=... pi -e ./pi-extension/src/index.ts
```

Or copy/keep it in a discovered extensions directory (e.g.
`~/.pi/agent/extensions/nano-llm/`) and pick up changes with `/reload`. Pi uses
jiti, so the TypeScript source runs directly — there is no build step.

The extension delegates streaming to Pi's built-in `openai-completions` API
implementation (`api: "openai-completions"`), so message conversion, tool calls,
usage accounting and cancellation behave exactly like a built-in provider. No
custom `streamSimple` is implemented.

Models come from `GET {baseURL}/models`, fetched by `refreshModels` (respecting
`context.signal` and skipped when `context.allowNetwork` is false). On failure
the fallback list is kept so the provider never disappears.

### B. `models.json` (no code)

Copy `examples/pi-models.json` to `~/.pi/agent/models.json`. Static list; `/model`
reloads the file.

## Notes

- Neither `/models` response is assumed to carry capability metadata. Discovered
  models are registered as text-only, non-reasoning, zero-cost, with a 128k
  context window and 8k max output. Override per model if the endpoint reports
  different values (`context_length` / `context_window` / `max_tokens` are read
  when present).
- The endpoint returns `401` with `www-authenticate: Bearer realm="nano-llm-proxy"`
  when the key is missing or invalid.
- Pi hides a model from `/model` until it can resolve credentials, so export
  `NANO_LLM_API_KEY` in the shell that starts Pi.

## License

Apache License 2.0 — see [LICENSE](LICENSE).
