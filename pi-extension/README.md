# nano-llm for Pi coding agent

[nano-llm](https://github.com/sadmansakib/nano-llm) gateway as a Pi coding agent extension (OpenAI-compatible).

## Install

```sh
pi install npm:nano-llm-pi-extension
```

Set your gateway API key:

```sh
export NANO_LLM_API_KEY=<your-key>
```

Optional env overrides: `NANO_LLM_BASE_URL` (default `https://<your-nano-llm-endpoint>/v1`), `NANO_LLM_API_KEY_ENV` (alternate key variable name).

Use with: `pi --model nano-llm/<model-id>` — run `pi --list-models | grep nano-llm` for the list.

## License

Apache-2.0
