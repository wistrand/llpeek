# Plan: logit-step visualizer

> Status: phases 1 to 3 done 2026-09-26. Remaining items under Open questions.

## Goal

Show, for a prompt and a running generation, each step's top-K candidate tokens
with their probabilities, so a reader can see where the model was confident, where
it hesitated, and which alternatives it discarded. Local models only, via
`llama-server`.

## Current state

`docs/app.html` holds the data layer and the Sankey UI, described in
[architecture-app.md](architecture-app.md). Deno tasks launch llama-server, the
static server, the headless check and screenshots. The llama-server API is in
[architecture-llama-server.md](architecture-llama-server.md).

## Approach

Thin client over `llama-server`. The server already does tokenization, inference
and top-K extraction, and allows cross-origin requests, so the UI can be a static
web page that talks to `llama-server` directly. No middle tier unless a
later feature needs one (e.g. recording sessions to disk).

Data flow per generation:

1. `POST /tokenize` with the prompt to show the prompt's tokens.
2. `POST /completion` with `stream: true`, `n_probs: K`, explicit sampling params.
3. For each SSE event, append a step: sampled token plus its `top_logprobs`.
4. Render steps as a sequence; selecting a step expands its candidate distribution.

Alternatives considered:

- Calling libllama directly (Python bindings or C) would give full-vocabulary
  logits, not just top-K. Rejected for v1: `n_probs` up to a few hundred is enough
  for visualization, and the server keeps the project free of native builds.
- `/v1/completions` for OpenAI-client compatibility. Rejected: the native endpoint
  has a simpler stream shape and richer metadata.

## Testing methodology

No automated tests (per repo conventions, tests are not run by agents). Verify by
hand: start the server on the 2B model, load the page, run a fixed prompt at
`temperature: 0` with `seed` set, and check that the rendered candidates match a
`curl` of the same request. Keep one such reference request and its captured JSON
in `docs/fixtures/` once the UI exists, so a regression can be spotted by diff.

## Phases

### Phase 1: data layer

- [x] Decide stack: single static HTML file, no build step.
- [x] Client for `/health`, `/props`, `/tokenize`, streaming `/completion`.
- [x] Parse SSE into a typed `Step { index, id, token, bytes, logprob, prob, rank, candidates[], remainder, text, partial }`;
      the sampled token is inserted into `candidates` with `rank: -1` when the server's top-K omits it.
- [x] Merge broken-UTF-8 fragments across steps: the step completing a character owns its `text`; prefix steps get `''` and `partial: true`.

**Verify:** `node scripts/check.js <base>` runs the reference prompt streamed and
non-streamed and compares ids, logprobs, candidates and text. Passed on the 2B
model: 6 steps, " Paris.\nA. True", stream matches non-stream.

### Phase 2: candidate-mass Sankey

Replaced the planned token strip + bar chart with one combined view: a
Sankey-style trace where each column is a step's distribution and the sampled
node's ribbon fans into the next column. Bars per step are the columns themselves.

- [x] Prompt input, sampling controls (temperature, top_k, top_p, min_p, seed, n_probs).
- [x] Sankey: columns sum to 1 with a hatched "other" node; unchosen candidates end as fading stubs.
- [x] Text strip, tooltip with path logprob, click-to-select, table view fallback.
- [x] Live update while streaming; light and dark mode.
- [x] `deno task shot` for headless screenshots; reference images in `docs/`.

**Verify:** `deno task check` passes; `deno task shot` on the reference prompt at
`seed=3, temperature=1.0, n_predict=14` produces the images in `docs/`, where step
4 shows " a" (12%) sampled below " located" (32%).

### Phase 3: exploration

- [x] Branching: click a candidate not taken to fork a new lane that continues
      from the exact token prefix (mixed string + ids prompt). Lanes are runs;
      each gets the next categorical color; ribbons join fork node to lane.
- [x] Compare sampling settings: "add run" adds a root lane with current settings.
- [x] Chat template mode with a thinking on/off toggle (`/apply-template`,
      `enable_thinking`).
- [x] Collapsible lanes with a height tween; branches auto-fold unrelated lanes.
- [x] Controls split into basic and "advanced"; Ctrl+Enter runs, Escape stops;
      output text is scrollable and its tokens link to the chart.
- [x] Raising "length" after completion extends runs that hit the limit.
- [x] Sampler view: post-sampling overlay via a seeded second pass, labelled
      in the legend, never mixed into the raw distribution.
- [x] In-browser engine via wllama; default model the public 2B Qwen Q8_0 from
      Hugging Face (same file as the local server default).
- [x] Compact layout: column width encodes hesitation (closed columns as wide as
      their token label, open columns sized to their candidate labels), tweened.
- [x] GitHub Pages site in `docs/` with the browser engine as the default path;
      the app itself lives there (no generated copy), served locally from the same dir.

**Verify:** mixed prompt `["The capital of France is", 11751, 13]` evaluates 7
tokens and continues identically to the original run. `deno task shot` with
`branch=4:1&branch=7:1` on the reference prompt produces `docs/screenshot-*.png`
with three lanes.

### Phase 4: comparing runs

- [x] Difference view (2026-09-27, on by default): "compare runs" draws three tracks under the
      lanes, aligned to the columns from the divergence step: token match,
      entropy in bits, and accumulated path logprob per run. A summary sentence
      sits under the chart; the numbers as a table only in advanced mode. Root
      runs with the same prompt compare from the first differing token;
      branches from the fork.
- [ ] Semantic divergence: distance between the two continuations' embeddings,
      per step or for the whole tail. Needs an embedding source: wllama has
      `createEmbedding`, llama-server only serves `/embedding` when started with
      `--embedding` (and the 2B chat model's embeddings are of doubtful quality;
      a small dedicated embedding model would be a second download). Decide
      whether it is worth a second model before building it.
- [x] Browser model list (2026-09-27): SmolLM2 360M, Gemma 3 1B, Llama 3.2 1B
      and SmolLM3 3B Q4 next to the Qwen quants, with byte sizes for the note
      next to the load button (a warning at 1 GB and up). The first three were
      probed headless and generate through their own chat templates; SmolLM3
      was only checked for size and CORS.
- [x] Think bias only when the chat template mentions `<think>` (2026-09-27);
      the string form was banning `<`, `think`, `>` on other models. See gotchas.
- [x] "Other" bucket computed over the candidates shown (2026-09-27), so a
      column with a beyond-top-K sample sums to 1.
- [x] Closed-column threshold adjustable under advanced (`closed_p`, 2026-09-27).
- [x] Emphasis by hesitation (2026-09-27): sampled nodes and ribbons fade with
      certainty; a dashed outline marks picks below the top candidate. The
      geometry is unchanged, only the ink weight.

**Verify:** `deno task headless "<app>?run=1&engine=server&base=http://localhost:8089&prompt=The%20capital%20of%20France%20is&n_predict=8&seed=3&temperature=1.0&branch=4:1&compare=1" 90 "document.querySelectorAll('#chart .cmp rect').length + ' | ' + document.getElementById('compare').innerText"`
prints a rect count above zero and a summary starting "From step 4". `deno task shot`
with the same URL shows the three tracks under the lanes, aligned to the columns.

## Open questions

- **Rendering cost.** `render()` rebuilds the SVG on every step. Measured
  2026-09-27 in headless Chrome, three lanes: 240 columns (7.5k SVG nodes)
  rebuild in about 2 ms of script time, 600 columns (19k nodes) in about 6 ms,
  against a 28 ms per-token budget at 35 tok/s and 16 ms per animation frame.
  Layout and paint after the swap are not in those numbers. Not worth
  optimizing until traces get several times longer; the cheap step then is to
  coalesce streamed tokens into one render per animation frame.
- **Model picker for llama-server.** It loads one model per process. Either
  restart the server from the UI (needs a middle tier) or document manual
  restarts. The browser engine has its own picker.
- **WebGPU in the browser engine.** wllama reports support in Chrome; not yet
  measured whether it beats the 12 tok/s CPU path on this machine.
