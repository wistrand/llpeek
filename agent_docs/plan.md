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
- [x] Research-review fixes (2026-09-27): surprisal in bits next to every
      percentage (tooltip, table, status line, compare summary); token match by
      longest common subsequence instead of position; "likelier is not better"
      caveat with mean surprisal per token in the compare summary; a warning
      when the prompt ends in a space.
- [x] Emphasis by hesitation (2026-09-27): sampled nodes and ribbons fade with
      certainty; a dashed outline marks picks below the top candidate. The
      geometry is unchanged, only the ink weight.

**Verify:** `deno task headless "<app>?run=1&engine=server&base=http://localhost:8089&prompt=The%20capital%20of%20France%20is&n_predict=8&seed=3&temperature=1.0&branch=4:1&compare=1" 90 "document.querySelectorAll('#chart .cmp rect').length + ' | ' + document.getElementById('compare').innerText"`
prints a rect count above zero and a summary starting "From step 4". `deno task shot`
with the same URL shows the three tracks under the lanes, aligned to the columns.

### Phase 5: resampling from a step (done 2026-09-27)

Goal: turn a branch from an anecdote into a measurement. One branch is one
draw; N draws from the same point show how much the continuation depends on
the token chosen there versus on later randomness (Bigelow et al. 2024,
Forking Paths: a few positions decide the ending, most do not).

Decisions:

- **What is redrawn.** "Resample from step g" continues from the prefix up to
  and including step g-1 and lets the sampler redraw step g and everything
  after it. So the fork token itself varies, which is what makes step g's
  importance measurable. (Continuing N times after a fixed token is the other
  question; it is the same machinery with the prefix one token longer, and can
  be a checkbox later.)
- **Seeds.** Sample k uses `seed + k` (k = 1..N). llama-server and wllama
  restart the random stream per request, so distinct seeds give distinct
  draws and the set is reproducible. At randomness 0 every draw is identical:
  disable the action and say why.
- **Samples are not lanes.** `MAX_RUNS` is 8 with one categorical color each.
  A sample set is one object, `{ run, g, n, seed, params, samples: [{ seed,
  steps, final }] }`, generated through the same `generate()` path (mixed
  prompt on the server, `prefixPrompt` text in the browser), streamed one
  sample at a time with "sample 3 of 8" in the status line. One set at a time;
  a new resample replaces it, and it is dropped when the page starts over.
  Extending its run keeps it (the prefix is unchanged). Stopping mid-set keeps
  the finished samples and makes their count the set's N.
- **View: a count Sankey under the lanes.** Same geometry as a lane, but a
  node is (step, token) with height = count / N and a link between consecutive
  steps carries the number of samples that took that pair. Columns sum to N,
  no "other" node (every sample is drawn). This is a true Sankey, not a trie:
  samples that reach the same token at the same step merge. Node labels
  `token k/N`; the lane label names the source run, the step, N and the seeds.
  Drawn in the source run's color at reduced strength, so it reads as a
  spread of that run.
- **Readouts** in a panel under the tracks, same pattern as compare:
  1. At step g: the drawn frequencies next to the model's stated
     probabilities for each token (`n_probs`, and the post-sampling
     distribution when "show sampler filtering" is on). This is an empirical
     check of the sampler, and shows the filters' effect directly.
  2. Distinct continuations: the samples grouped by exact final text, largest
     group first, with counts. Outcome entropy over the groups in bits.
  3. Agreement curve: for each step after g, the share of samples that still
     share the majority prefix. Where it collapses is where the paths fork.
  4. Mean surprisal per token per sample, so a group of generic continuations
     is visibly cheaper than an unusual one.
- **Controls.** A toolbar button "resample from the selected step ×N",
  enabled when a sampled node is selected and randomness > 0; N in advanced
  (default 8, max 32). Query string `resample=<step>:<n>` for headless runs
  and screenshots. The tooltip's "Click to see what would have followed"
  becomes "Click for one continuation from here".
- **Cost.** N requests of `n_predict` tokens. 8 × 14 tokens on the 2B model at
  35 tok/s is about 4 s on the server, 10 s in the browser. Sequential
  requests; the server's parallel slots would only matter for larger N.
- **Not in this phase.** Resampling at every position (the full Forking Paths
  sweep, N × T requests) and grouping continuations by meaning rather than
  exact text. Both build on the sample set object; the sweep is a loop over g
  with a heatmap of outcome change per step, the grouping needs an embedding
  or entailment model (see semantic divergence under Phase 4).

Built as planned, with these additions: the source column carries a dashed
marker and a ribbon from the token before it leads into the sample lane; a
selected token shows an in-place "resample ×N" label at its column (also the
toolbar button, which names the target, and the `r` key); the fork track is
drawn under the count Sankey rather than in the panel; readouts 3 and 4 are
the track and a column in the continuation table. Per-sample columns take
part in `layoutColumns()` so the lane aligns with the runs.

Revised after a statistics review (2026-09-27):

- The redrawn step is compared with the sampler's own distribution, fetched
  with one `post_sampling_probs` request per set, not with the raw `n_probs`
  probabilities: the raw 32% for " located" was really 42.5% after top-p,
  min-p and temperature, and 32 direct draws with consecutive seeds gave 14,
  so consecutive seeds do draw independently. The table shows expected counts
  and a Wilson 95% interval per share, marks a sampler probability outside it,
  and says that step g's draws only check the sampler.
- The fork track is the size of the largest group of samples sharing the same
  prefix at each depth (`largestBranch`), a size that ties cannot change,
  instead of a majority path with order-dependent tie breaks.
- Outcome groups are taken over a horizon (first 1, 2, 4 or 8 tokens, the
  first sentence, or the whole text; a select in the panel, default 2),
  because exact text saturates at log2 N almost immediately. On the reference
  prompt at N=8, one token gives 3 distinct groups, two give 5 against 7 with
  the token kept, four give 8 and 8. The panel says so.
- The kept-token set is built by the same action (`keep_too`, on by default):
  N more draws from step g+1 with the run's token at g fixed. The panel
  reports both spreads and their entropy difference as what the token at g
  accounts for, which is the Forking Paths comparison.
- Samples carry a `done` flag; stopping keeps every finished sample even when
  its stream ended without a stop event. The trailing-space warning is hidden
  in chat mode. The compare view's common-subsequence match is cached per
  pair and lengths, since `render()` runs every animation frame.

**Verify:** `resample=4:8` on the reference prompt at `seed=3, temperature=1.0,
n_predict=10` gives two sets of 8 (the second keeping " a"); " located" is
drawn 6 of 8 with a sampler probability of 43% inside the 41% to 93%
interval; over the first 2 tokens the redraw set has 5 distinct groups and
the kept set 7; identical on a second run (checked 2026-09-27 against the 2B
Qwen on 8089; the status line starts "Resampling done"). At `temperature=0`
the status says randomness is 0 and the button stays disabled. Preemption: an
async headless expression that clicks a node, starts a resample of 4 while
`resample=4:32` is running, ends with "Resampling done ... 4 times and 4 more"
and four track headings.

## Open questions

- **Chrome's built-in model is not usable as an engine** (checked 2026-09-28).
  The Prompt API (`LanguageModel`, Gemini Nano in Chrome 138+, Phi-4-mini in
  Edge) returns text only: no logprobs, candidate tokens or logits, no seed,
  chat sessions only, and on the web no sampling parameters beyond an
  origin-trial `samplingMode` enum (extensions get `topK`/`temperature`).
  The logprobs request is webmachinelearning/prompt-api#20, open since July
  2024 with no editor response. llpeek needs pre-sampling top-K per token, so
  wllama stays the browser engine. Revisit if #20 moves.

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
