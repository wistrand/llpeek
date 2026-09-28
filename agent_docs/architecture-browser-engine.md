# Architecture: in-browser engine (wllama)

The second engine runs llama.cpp inside the page via
[wllama](https://github.com/ngxson/wllama) (WebAssembly). Everything below was
verified in headless Chrome on 2026-09-26 with wllama 3.6.1 and
`Qwen_Qwen3.5-2B-Q8_0.gguf`; see `scripts/wllama-probe.html` for the probe page
(`deno task serve`, then `deno task headless http://localhost:8000/scripts/wllama-probe.html`).

## Contents
- Loading
- Request and response format
- Differences from llama-server, and how the app bridges them
- Performance
- Static server requirements

## Loading

`llpeek.browserEngine(modelUrl, opts, onProgress, onPhase)` in the data layer.
`onProgress({loaded, total})` is wllama's byte progress; `onPhase` reports
`runtime` (importing wllama and jinja), `download`, `load` (into memory, no
byte progress, a few seconds for the 2B model) and `ready`. The UI shows a
`<progress>` bar with percent, a smoothed MB/s and time left, indeterminate
during the phases without bytes. Steps:

1. `import()`s `@wllama/wllama` and `@huggingface/jinja` from jsdelivr, on demand.
   The page has no dependencies until the user picks the browser engine.
2. `new Wllama({ default: <cdn>/esm/wasm/wllama.wasm })` (8.4 MB), then
   `loadModelFromUrl(url, { n_ctx: 4096, progressCallback })`. wllama caches the
   GGUF in the browser (OPFS), so the second load skips the download.
3. Chat template: `wllama.getChatTemplate()` returns the jinja source, rendered
   client-side with `@huggingface/jinja`'s `Template.render({ messages,
   add_generation_prompt: true, enable_thinking, bos_token: '', eos_token: '' })`.
   Output matched llama-server's `/apply-template` byte for byte for Qwen3.5.

Model URLs: any CORS-enabled URL. The UI offers a curated list (`MODELS` in the
UI block: Qwen3.5 2B in two quants, SmolLM2 360M, Gemma 3 1B, Llama 3.2 1B,
SmolLM3 3B Q4, stories260K, each with its byte size for the note next to the
load button; a typed URL is sized with a HEAD request, which the Hugging Face
CDN answers with CORS; 1 GB and up is shown as a warning, unless the model is
already cached: `llpeek.browserCached()` imports wllama's JS module (not the
WASM) and asks `new ModelManager().getModels()` for the validated cached
URLs, once per page, plus each URL loaded since; the note then says it loads
from the cache) and a free URL field.
The string-form
`logit_bias [["<think>", false]]` is only sent when the model's chat template
mentions `<think>`. Reason: llama-server (also the copy inside wllama) tokenizes
a string entry and biases every resulting token, verified 2026-09-27 with
`[[" Paris is", false]]` banning " Paris". On a model without a `<think>`
token the string would ban the pieces "<", "think" and ">" instead. wllama
3.6.1 has no tokenizer call in JS, so the template is the only cheap signal.
Default (since 2026-09-28): Hugging Face `bartowski/Qwen_Qwen3.5-2B-GGUF`,
file `Qwen_Qwen3.5-2B-Q4_K_M.gguf` (1.40 GB); the Q8_0 next to it (2.08 GB)
is byte-identical to the local server default, so pick it when a browser run
must match a server run: quantizations give different probabilities. Hugging Face `resolve` links 302 to
a CDN; with a browser `Origin` header the redirect echoes the origin and the CDN
answers `access-control-allow-origin: *` (verified from `http://localhost:8000`).
Local files are deliberately not served: the page must work the same from any
origin, and a 2 GB file is fetched once and then cached by wllama.

## Request and response format

`createCompletion` passes its options JSON straight into the WASM build of
llama-server (`cmpl_req.data_json`), so native fields work: `n_probs`, `seed`,
`top_k`, `top_p`, `min_p`, `logit_bias`, `post_sampling_probs`. Output is
llama.cpp's OpenAI-completions format with the extended per-token objects:

```
chunk.choices[0].logprobs.content[] = { id, token, bytes, logprob, top_logprobs[] }   // or prob/top_probs
chunk.choices[0].finish_reason = null | 'length' | 'stop'
final chunk: usage.prompt_tokens, timings
```

Streaming (`stream: true` without `onData`) returns an async iterable; each
chunk carries one token's candidates. The engine's `completion()` maps this to
the native event shape the rest of the app consumes.

## Differences from llama-server, and how the app bridges them

| llama-server                              | wllama                                              | Bridge                                                                  |
|-------------------------------------------|-----------------------------------------------------|-------------------------------------------------------------------------|
| mixed prompt `[string, ...ids]`           | string prompts only (`type must be string` error, then the worker is wedged) | `engine.prefixPrompt(prompt, ids, text)`: text built from the exact bytes of the prefix tokens. Verified to re-tokenize identically for ASCII paths; `checkPrefix()` compares `usage.prompt_tokens` with root prompt length + prefix length and warns on drift |
| `/tokenize`                               | none                                                | `engine.tokenize` is null; status omits the prompt token count          |
| `/apply-template`                         | template source only                                | jinja rendered client-side                                              |
| `logit_bias [[id, false]]`                | same, and the string form `[["<think>", false]]` works; a multi-token string bans every piece | browser engine uses the string form, only when the template mentions `<think>` |
| `stop_type: limit / eos`                  | `finish_reason: length / stop`                      | mapped in `completion()`                                                |
| any file size                             | one file up to 2 GB (ArrayBuffer limit); split with `llama-gguf-split --split-max-size 512M` for bigger | the 2B Q8_0 (2.08e9 bytes) fits; SmolLM3 and larger local files do not without splitting |

Seeded sampling reproduces across pre- and post-sampling requests, so the
sampler view works unchanged.

## Performance

Headless Chrome, CPU WASM, 8 threads, Intel Panther Lake:

| Metric                         | Value          |
|--------------------------------|----------------|
| model download                 | bandwidth-bound (2.08 GB from Hugging Face; ~11 s when it was served from localhost) |
| load after download            | ~3 s           |
| generation                     | 12 tok/s       |
| prompt eval                    | 16 tok/s       |

Native llama-server on the same machine does 35 tok/s. wllama reports WebGPU
support in Chrome; whether it is used for this model was not measured.

## Static server requirements

Multi-threaded WASM needs `SharedArrayBuffer`, which needs cross-origin
isolation. `scripts/serve.ts` sends `Cross-Origin-Opener-Policy: same-origin`
and `Cross-Origin-Embedder-Policy: credentialless` on every response. Under
`credentialless`, jsdelivr (sends CORP cross-origin) and CORS fetches to
llama-server keep working. Opening `app.html` from `file://` gives the
single-threaded build, several times slower.

GitHub Pages cannot send these headers. `docs/coi-serviceworker.js` adds them
to every response from inside a service worker; the app registers it only when
the page is not already isolated and the context is secure (https, or
localhost), then reloads once the worker controls the page. Verified with
`deno task pages` (PAGES=1: no headers, no local flag): a fresh headless Chrome
profile registered the worker, reloaded, and reported `crossOriginIsolated`
true with the multi-threaded build. With plain `deno task serve` the headers
already isolate the page, so the worker never registers.
