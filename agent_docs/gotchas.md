# Gotchas and findings

Traps in the llama-server API and this machine's setup. Append as discovered.

## Contents
- Traps
- Findings

## Traps

- **`n_probs` and `post_sampling_probs` answer different questions.** `n_probs`
  gives logprobs from the raw softmax over the full vocabulary (what the model
  believes). `post_sampling_probs` gives the distribution after top-k/top-p/min-p/
  temperature have pruned it (what the sampler could pick from). At `temperature: 0`
  the latter is always a single entry with `prob: 1.0`. Never mix them in one view
  without labelling which is which.
- **The sampled token may be missing from `top_logprobs`.** The list is the raw
  top-K; at nonzero temperature the sampled token can rank below it and then only
  appears in the outer `id`/`token`/`logprob`. Render the sampled token from the
  outer fields and add it to the candidate list if absent, and compute the
  "other" bucket over the candidates actually shown, not the raw top-K, or that
  column sums to more than 1 (llpeek did until 2026-09-27).
- **Top-K logprobs do not sum to 1.** The missing mass is the rest of the vocabulary
  (150k+ tokens for Qwen). Show it as an explicit "other" bucket or the chart lies.
- **`token` strings can be broken UTF-8.** Multibyte characters are often split
  across tokens; the `token` field then holds a fragment. Decode from `bytes` and
  merge adjacent fragments when rendering.
- **`tokens` is empty in non-stream `/completion` unless `return_tokens: true`.**
  In stream mode it is filled per chunk. Do not rely on it; use the `id` inside
  `completion_probabilities`.
- **Default `-c 0` takes the context size from the model.** For Qwen3.5 that is
  large and allocates a big KV cache across 4 slots. Pass `-c 4096` or similar for
  interactive use.
- **The server allows CORS `*` and no API key by default.** Convenient (a static
  page can call it directly) but do not expose the port beyond localhost.
- **Port 8080 is occupied on this machine by a Keycloak Docker container**
  (`keycloak-keycloak-1`, `docker ps` shows the mapping; `ss -p` does not name it
  because the process is root's). `deno task llama` therefore defaults to 8089 and
  the page's server field to `http://localhost:8089`. Probes use 18099.
- **Never `pkill`/`kill $(pgrep llama-server)` from an agent.** It kills the
  user's own server (started by `deno task dev`) along with the probe, and
  `pkill -f` also kills the calling shell (exit 144). Capture the probe's PID at
  start (`llama-server ... & PID=$!`) and kill only that.
- **Thinking-trained models open `<think>` on their own, even in raw mode.**
  Qwen3.5 puts 79% on `<think>` after a prompt ending in a colon. The chat
  template's `enable_thinking: false` only helps in chat mode, so with thinking
  off the page also sends `logit_bias [[<think id>, false]]` in every mode. The
  id is looked up per server via `/tokenize`; models whose `<think>` is not a
  single token get no bias.
- **A string entry in `logit_bias` biases every token it tokenizes to.**
  `[[" Paris is", false]]` banned " Paris" (verified 2026-09-27 on 8089). On a
  model whose `<think>` is one special token the string form blocks that token,
  same as the id form; on a model without it, `"<think>"` becomes the pieces
  `<`, `think`, `>` and all three get banned. The browser engine has no
  tokenizer call, so it sends the string form only when the chat template
  mentions `<think>`. Never send a string bias without knowing it is one token.
- **Thinking is a chat-template feature, not a sampling one.** In raw prompt mode
  the model just continues the text; `<think>` only appears when the prompt was
  rendered by the chat template. "Thinking off" means the template pre-fills an
  empty `<think>\n\n</think>` block (Qwen3.5, SmolLM3); the model then answers
  directly. SmolLM3 with thinking on injects a long reasoning system prompt
  instead of a tag.
- **Qwen3.5-2B logs "unused tensor blk.24.*" warnings at load.** These are the
  model's MTP/next-token-prediction head, which llama.cpp ignores. Harmless.
- **Sampling defaults are not neutral.** `/props` shows `top_k 40`, `top_p 0.95`,
  `min_p 0.05`, `temperature 0.8`. They affect which token is picked but not the
  `n_probs` logprobs. Set them explicitly in requests so the UI's display of "what
  was sampled" is reproducible; use `seed` for repeatability.

- **Two elements shared `id="resample"` for a while** (the toolbar button and
  the panel), so `$('resample')` returned the button and the panel's tables
  were written into it. `document.getElementById` returns the first match
  silently; grep the ids before adding one. The panel is `resamplePanel`.
- **`Runtime.evaluate` does not await a promise unless asked.** An async
  expression came back as `[object Object]` until `headless.ts` passed
  `awaitPromise: true` (2026-09-27). With it, an expression can click, wait
  and read the result in one run.
- **The headless tools decide "idle" from the status line.** `scripts/headless.ts`
  and `scripts/shot.ts` wait until Stop is disabled and the status matches
  done, error, stopped or ready (plus a few fixed phrases). A new final status
  without one of those words makes every headless check time out, which is
  how the first resampling status was caught (2026-09-27).
- **Pixel-diffing screenshots across server sessions is noisy.** Two
  screenshots of the reference URL taken an hour apart differed in about
  2,500 pixels although the sampled text was identical: several percentages
  were off by one point (inferred: llama-server's logits vary slightly with
  slot and batch state, not a renderer change). Two runs minutes apart on the
  same server differed by about 100 pixels (the timing digit in the status
  line). Compare against a screenshot taken in the same session.
- **Headless Chrome `--screenshot` with `--virtual-time-budget` does not wait for
  an SSE stream.** It captured the page mid-generation. `scripts/shot.ts` drives
  Chrome over the DevTools protocol and polls the status line for `done` instead.
- **Headless Chrome on this machine defaults to dark mode.** `shot.ts` forces
  each scheme with `Emulation.setEmulatedMedia`; do not trust a single screenshot
  to show light mode.
- **`deno task dev` runs two servers with `&`.** Ctrl-C stops both, but a crashed
  static server leaves llama-server running. Check `pgrep llama-server`.

- **wllama rejects a mixed `[string, ...ids]` prompt and then wedges.** The
  first error is `type must be string, but is array`; the next call fails with
  `Invalid magic number` because the worker's glue stream is out of sync. Only
  send string prompts to the browser engine (the engine's `prefixPrompt` does).
- **`file://` gives the slow single-threaded wllama build.** Multi-threading needs
  cross-origin isolation, which only `scripts/serve.ts` provides.
- **GGUFs over 2 GB cannot load in the browser unsplit.** The 2B Q8_0
  (2.08e9 bytes) fits; anything larger needs `llama-gguf-split` and a URL to
  the first shard.
- **Every headless Chrome run downloads the model again.** wllama's cache lives
  in the browser profile, and headless runs start fresh, so each
  `deno task headless` or browser-engine `deno task shot` pulls the default
  model (1.4 GB) from Hugging Face. Use `model=<stories260K url>` for cheap probes, and the 0.4 GB
  SmolLM2 360M when the output has to make sense (both URLs in `MODELS`).
- **Official `Qwen/*-GGUF` and `ggml-org/Qwen3.5-*` repos answer 401.** Use
  `bartowski/Qwen_Qwen3.5-2B-GGUF` or `unsloth/Qwen3.5-2B-GGUF`, both public.
  The local files map to: Qwen 2B/4B from bartowski, `SmolLM3-Q8_0.gguf` from
  `ggml-org/SmolLM3-3B-GGUF`, both granites from `ibm-granite/*-GGUF`
  (bartowski's granite-4.2 repo is 401). `scripts/models.ts` holds the URLs.

## Findings

### Branches sampled `<think>` although thinking was off

- **Symptom:** the root run skipped a 79% `<think>` candidate, but a branch
  forked from it sampled `<think>` at 83% and started reasoning.
- **Diagnosis:** `branch()` built its run with `newRun()`, whose params come
  from the controls. `logit_bias` and the `think` flag are computed in
  `startRun` only for root runs, so branches never had the bias.
- **Fix:** a branch copies `parent.params` verbatim.
- **Takeaway:** anything derived at run start (bias, think, seed) must be
  inherited by branches and extensions, never recomputed from the controls.

### Streaming delivers logprobs per token

- **Symptom:** unclear whether candidates arrive incrementally or only at the end.
- **Diagnosis:** with `stream: true`, every `data:` event carries a one-element
  `completion_probabilities` for the token just produced; the final `stop: true`
  event carries none.
- **Takeaway:** the visualizer can render live, token by token, straight from the
  SSE stream. No need to wait for the full response.
