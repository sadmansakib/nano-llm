# nano-llm for OpenCode V2

[nano-llm](https://github.com/sadmansakib/nano-llm) gateway as an OpenCode V2 plugin (OpenAI-compatible).

## Install

```sh
opencode plugin add nano-llm-opencode-plugin
```

Then authenticate: `/connect` → **Login with API key** → **nano llm** (key from the gateway), or set `NANO_LLM_API_KEY`.

Optional env overrides: `NANO_LLM_BASE_URL` (default `https://<your-nano-llm-endpoint>/v1`).

Use with: `opencode -m nano-llm/<model-id>` — run `opencode models | grep nano-llm` for the live list.

## License

Apache-2.0
