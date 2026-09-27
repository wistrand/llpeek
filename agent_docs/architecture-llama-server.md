# Architecture: llama-server API contract

llpeek's only backend is llama.cpp's `llama-server`. This file records the parts of
its HTTP API llpeek depends on, with response shapes captured from a real run
(llama.cpp build 10809, commit 5266f24, Manjaro package, 2026-09-26). Re-probe
after upgrading llama.cpp; do not extend these shapes from memory.

## Contents
- Starting the server
- `/completion` (native, use this)
- Streaming
- `post_sampling_probs`
- `/v1/completions` (OpenAI-compatible, avoid for logprobs)
- `/tokenize`, `/props`, `/health`
- Local environment

## Starting the server

```bash
llama-server -m ~/models/Qwen_Qwen3.5-2B-Q8_0.gguf --port 8089 -c 4096   # = deno task llama
```

| Flag              | Meaning                                                       |
|-------------------|---------------------------------------------------------------|
| `-m PATH`         | GGUF model                                                    |
| `--port N`        | llama.cpp default 8080; this project uses 8089 (8080 is taken here) |
| `-c N`            | context size; 0 = take from model (can be large, wastes RAM) |
| `-ngl N`          | layers to offload to GPU; irrelevant on CPU-only builds       |
| `--jinja`         | on by default; only matters for `/v1/chat/completions`        |

Defaults that matter: 4 parallel slots, CORS `*` with no API key (the server warns
about this at startup; fine for a localhost tool, so the browser can call it directly).

## `/completion` (native, use this)

Request:

```json
{"prompt": "The capital of France is",
 "n_predict": 4,
 "n_probs": 5,
 "temperature": 0,
 "stream": false}
```

- `n_probs`: number of top candidates returned per generated token. This is the
  field llpeek is built around.
- `return_tokens: true` fills the top-level `tokens` array with generated token ids
  in non-stream mode (it is `[]` otherwise). Not needed: ids are in
  `completion_probabilities` anyway.
- Any sampling parameter (`temperature`, `top_k`, `top_p`, `min_p`, `seed`, ...) can
  be set per request. `/props` lists the defaults.

Response, top level (other fields omitted):

```json
{"content": " Paris.\n",
 "tokens": [],
 "tokens_predicted": 3,
 "tokens_evaluated": 5,
 "stop": true, "stop_type": "limit",
 "generation_settings": { "...": "echo of effective sampling params" },
 "timings": { "...": "prompt/eval ms and tok/s" },
 "completion_probabilities": [ "one entry per generated token, see below" ]}
```

Each element of `completion_probabilities`:

```json
{"id": 11751, "token": " Paris", "bytes": [32,80,97,114,105,115],
 "logprob": -0.7168791890144348,
 "top_logprobs": [
   {"id": 11751, "token": " Paris", "bytes": [32,80,97,114,105,115], "logprob": -0.7168791890144348},
   {"id": 279,   "token": " the",   "bytes": [32,116,104,101],       "logprob": -3.0381834506988525},
   {"id": 264,   "token": " a",     "bytes": [32,97],                "logprob": -3.3134043216705322}]}
```

- Outer `id`/`token`/`logprob` describe the token actually sampled.
- `top_logprobs` has exactly `n_probs` entries sorted by descending logprob. It is
  the raw top-K and does not include the sampled token when that token ranks
  lower (verified: at `temperature 2, top_k 0, n_probs 2`, 39 of 40 sampled tokens
  were absent from the list). The outer `logprob` is still the sampled token's own
  value, so the UI always has it.
- `bytes` is the raw UTF-8 of the piece. Use it, not `token`, when a piece is a
  partial multibyte sequence (`token` may be a replacement char or fragment).
- Probability = `exp(logprob)`. The top-K entries do not sum to 1; the remainder is
  the tail of the vocabulary.

## Streaming

`"stream": true` returns server-sent events, one `data:` line per generated token,
each carrying a one-element `completion_probabilities` for that token:

```
data: {"index":0,"content":" Paris","tokens":[11751],"stop":false,"tokens_predicted":1,"tokens_evaluated":5,
       "completion_probabilities":[{"id":11751,"token":" Paris","bytes":[...],"logprob":-0.716,
                                    "top_logprobs":[{...},{...}]}]}

data: {"index":0,"content":".","tokens":[13],"stop":false,...,"completion_probabilities":[{...}]}

data: {"index":0,"content":"","tokens":[],"stop":true,"model":"...","generation_settings":{...},"timings":{...}}
```

- The final event has `stop: true`, empty `content`, and the full
  `generation_settings` / `timings` blocks. It has no `completion_probabilities`.
- In stream mode `tokens` is populated per chunk without `return_tokens`.
- This is the shape the visualizer should consume: render each token's candidates
  as the event arrives.

## `post_sampling_probs`

`"post_sampling_probs": true` replaces `logprob`/`top_logprobs` with
`prob`/`top_probs`, measured after the sampler chain has run (top-k, top-p, min-p,
temperature, ...). With `temperature: 0` the sampled token gets `prob: 1.0` and the
list collapses to one entry. It is a mode, not an extra field: one request returns
one or the other. A seeded request is reproducible, so the same request in both
modes yields the same token ids (verified: 12 tokens at `temperature 1.0, seed 7`),
which is how the app pairs the two. With the default `min_p 0.05`, a step whose
raw top-6 is 96.5% / 2.8% / 0.5% ... leaves a single survivor at 100%. Only useful
to show "what the sampler was left with"; never present it as the model's belief.
See [gotchas.md](gotchas.md).

## `/v1/completions` (OpenAI-compatible, avoid for logprobs)

`{"prompt": "...", "max_tokens": 2, "logprobs": 3}` returns
`choices[0].logprobs.content[]` with the same per-token objects (`id`, `token`,
`bytes`, `logprob`, `top_logprobs`). It works, but non-stream responses lack
`tokens_evaluated`/`timings` at the top level and the streaming shape follows
OpenAI chunk conventions. Prefer `/completion`.

## `/apply-template` (chat mode, thinking on/off)

`/completion` sends the prompt verbatim, so a plain prompt never triggers a
thinking block. To visualize a chat turn, render it through the model's template
first and feed the result to `/completion`:

```bash
curl -s localhost:8089/apply-template -d '{"messages":[{"role":"user","content":"What is the capital of France?"}],
  "chat_template_kwargs":{"enable_thinking":false}}'
```

Verified output (`prompt` field):

| Model      | `enable_thinking: true`                                   | `enable_thinking: false`                                              |
|------------|-----------------------------------------------------------|-----------------------------------------------------------------------|
| Qwen3.5 2B | `...<\|im_start\|>assistant\n<think>\n`                     | `...<\|im_start\|>assistant\n<think>\n\n</think>\n\n`               |
| SmolLM3    | long reasoning system prompt, assistant header, no tag    | default system prompt, `...assistant\n<think>\n\n</think>\n`         |

So "thinking off" is an empty think block pre-filled by the template. The
rendered string contains special tokens as text; `/completion` parses them
(verified: the chat prompt generates a normal assistant answer).

## `logit_bias` (blocking `<think>`)

`"logit_bias": [[token_id, false]]` forbids a token (`false` = minus infinity;
a number is an additive bias). Verified on Qwen3.5 2B, whose `<think>` is one
token, id 248068 (find it with `/tokenize` on the string `<think>`; the id
differs per model):

| Request                                  | Sampled (greedy) | Top-K reported by `n_probs`        |
|------------------------------------------|------------------|------------------------------------|
| prompt `The capital of France is:\n\n`   | `<think>` 79%    | `<think>` 79%, `A` 9%, `The` 4%    |
| same + `logit_bias: [[248068, false]]`   | `A` 9%           | unchanged: `<think>` 79%, `A`, ... |

So `n_probs` logprobs are pre-bias as well as pre-sampling: the chart keeps
showing the forbidden candidate, and the sampled node sits below it.

The string form `[["<think>", false]]` is tokenized by the server and the bias
applied to every resulting token. Verified 2026-09-27: `[["<think>", false]]`
blocks the special token on Qwen3.5 (same result as the id form), and
`[[" Paris is", false]]` bans " Paris" after "The capital of France is". Use the
id form when a tokenizer is available; see gotchas.

## `/tokenize`, `/props`, `/health`

```bash
curl -s localhost:8089/tokenize -d '{"content":"The capital","with_pieces":true}'
# {"tokens":[{"id":760,"piece":"The"},{"id":6511,"piece":" capital"}]}

curl -s localhost:8089/props      # default sampling params, model path, n_ctx, chat template
curl -s localhost:8089/health     # {"status":"ok"} once the model is loaded; "loading model" before
```

`/tokenize` lets the UI show the prompt split into tokens before generation starts,
using the same tokenizer the model uses.

## Local environment

| Item            | Value                                                                  |
|-----------------|------------------------------------------------------------------------|
| llama.cpp       | `/usr/bin/llama-server`, build 10809 (0.4.0-dev), distro package       |
| Backends        | CPU (`/usr/lib/ggml/libggml-cpu-*.so`), Vulkan, SYCL, BLAS available   |
| GPU             | Intel Arc B390 (integrated, Panther Lake). No NVIDIA; `nvidia-smi` absent |
| Models          | `~/models/*.gguf`: Qwen3.5 2B and 4B, SmolLM3, granite 4.0 tiny, granite 4.2 3B (all Q8_0) |
| Probe model     | `Qwen_Qwen3.5-2B-Q8_0.gguf`, ~2 s load, ~35 tok/s generation on CPU     |

`~/models/llama-bin-f46bc30-sm86-cuda12.8.tgz` is a CUDA (sm86, RTX 30xx) build of
llama.cpp for a different machine. It is not usable here and is not the installed
binary.
