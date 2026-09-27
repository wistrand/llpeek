# Architecture: the page

`docs/app.html` is the whole app. Script blocks:

| Block  | Contents                                                                 | Constraint                          |
|--------|--------------------------------------------------------------------------|-------------------------------------|
| first  | `llpeek` object: `health`, `props`, `tokenize`, `completion` (SSE), `generate`, `stepFrom`, `mergeText` | pure; no `document`; loaded by `scripts/check.mjs` |
| second | UI: controls, Sankey render with the compare tracks, text strip, table view, compare panel, tooltip, query-string prefill | may use everything                  |

## Contents
- Step model
- Runs and branching
- Prompt modes
- Sankey encoding
- Rendering loop
- Views and interaction

## Step model

`stepFrom(cp, index)` turns one `completion_probabilities` entry into:

```
{ index, id, token, bytes, logprob, prob, rank, candidates[], remainder, text, partial }
```

- `candidates`: the server's `top_logprobs` sorted by logprob desc, each with
  `rank` (0-based position in the raw top-K). If the sampled token is not in the
  top-K it is inserted with `rank: -1` and the step's `rank` is -1.
- `remainder`: `1 - sum(candidates[].prob)`, the mass outside the candidates
  shown. When the sampled token was beyond the top-K and got appended, it is
  taken out of the tail here, so a column always sums to 1.
- `text`/`partial`: set by `mergeText(steps)`. A step whose bytes complete a
  UTF-8 sequence owns the decoded text; steps that only contributed a prefix get
  `''` and `partial: true`. `mergeText` is idempotent and re-run on every step.

## Engines

`llpeek.serverEngine(base)` and `llpeek.browserEngine(modelUrl, opts, onProgress)`
expose one surface: `info`, `tokenize` (server only, else null), `applyTemplate`,
`prefixPrompt`, `thinkBias`, `completion`. Every run stores the engine it was
created on (`run.engine`); branches, extensions and the sampler pass reuse it,
so switching the engine selector affects only new runs. `currentEngine()` throws
until a browser model is loaded. See
[architecture-browser-engine.md](architecture-browser-engine.md) for the wllama side.

Local versus published: `scripts/serve.ts` injects
`<script>window.LLPEEK_LOCAL = true;</script>` into `app.html` as it serves it
(the file on disk is untouched). Without that flag, which is the case on
GitHub Pages and from `file://`, the page removes the server option, the
"run on" control, the server URL field and "check connection", and never
probes: browser engine only. With it, both engines exist and detection runs.
`deno task pages` (PAGES=1) serves without the flag and without the isolation
headers, which is the faithful local emulation of the published site.

Engine detection (`detectEngine`, local only): at startup, unless the query
string names an engine or `run=1`, the page probes `<base>/health` with a
1.2 s timeout (`llpeek.reachable`). A reply keeps the server engine and shows
the model name; no reply switches the select to the browser engine and
explains what to do. The URL field re-probes on change; nothing else ever
changes the select, so a manual choice stands.

Continuation is engine-specific: the server gets `[prompt, ...ids]`, the browser
gets `prompt + text` where text is decoded from the prefix tokens' exact bytes
(`run.prefixText` is built from bytes, not from merged display text).
`checkPrefix()` records the root run's prompt token count and warns when a
continuation's count disagrees.

## Deployment

`docs/` is the GitHub Pages site (Settings: deploy from branch, folder
`/docs`) and also what `deno task serve` serves locally, so there is one copy
of everything. `docs/index.html` is the landing page that explains the chart
and links to `app.html?engine=browser`. The app is engine-agnostic: on Pages
the browser engine is the default path, and a local llama-server still works
from there because browsers treat `http://localhost` as a secure context.

## Runs and branching

Every lane is a run:

```
{ n, prompt, params, start, prefix[], prefixText, parent, forkStep, forced, steps[], final }
```

- `n`: 1-based number and categorical color slot (`--s1`..`--s8`). At most 8 runs;
  colors are never cycled.
- `start`: global step index of the run's first generated token. Column x is
  `start + local index`, so lanes align.
- `prefix`: token ids fixed before generation (parent tokens up to the fork plus
  the forced candidate). The request prompt is `[prompt string, ...prefix]`, a
  mixed prompt llama-server tokenizes exactly, so a branch continues from the
  identical token sequence rather than re-tokenized text.
- `branch(parent, g, cand)` forks parent at global step `g` with candidate
  `cand`, inserting the new run after the parent's subtree (depth-first lanes).
- "add run" starts a new root run with the current settings and keeps existing
  lanes; that is the side-by-side comparison of sampling settings.
- "run" clears all runs.
- Clicking a candidate while something is generating aborts it (`ctrl.abort()`),
  awaits the in-flight promise (`active`) so the aborted run settles, then starts
  the branch. Every generation entry point assigns `active`.
- Raising "length" after runs exist calls `extendRuns(n)`: every run with fewer
  steps that stopped with `stop_type: "limit"` continues from
  `[prompt, ...prefix, ...generated ids]` for the missing tokens; new steps are
  appended and `mergeText` re-runs over the whole list so a UTF-8 fragment at the
  old end merges correctly. Runs that ended on EOS are left alone. Lowering the
  length does nothing.

## Prompt modes

- Raw (default): the textarea is the prompt.
- Chat template: the textarea is one user message rendered through
  `/apply-template`; the "thinking" checkbox maps to `chat_template_kwargs.enable_thinking`.
  Both default to off. Checking thinking checks chat mode; unchecking chat mode
  unchecks thinking. Never disable the thinking box; a disabled control reads as broken.
- Thinking off also adds `logit_bias [[<think id>, false]]` to the run's params
  (`thinkBias()`, id cached per server), in raw and chat mode alike, because
  thinking-trained models open the tag unprompted. Branches inherit it. The
  `think` flag lives in `run.params` for the legend and is stripped before the request.
  The rendered string becomes `run.prompt` and is shown muted in the text strip.

## Sampler view (post-sampling overlay)

`post_sampling_probs` is a server mode, not an extra field, so the overlay is a
second pass: `fetchPost(run)` replays each generation segment (`run.segments`,
one length per request that produced tokens) with the same params, seed and
`post_sampling_probs: true`, and attaches `step.post = { id, prob, top[] }`
only if the replayed ids match the original ones. Segments matter because the
sampler's random stream restarts per request, so an extended run is replayed in
the pieces it was generated in. Seeded sampling reproduces exactly on
llama-server (verified); `seed: -1` would diverge and the status line says so.

Rendering: a thin bar (`POST_W`) left of each node column, same order, heights
`prob * colH` (survivors are renormalized, so the bar is full height when
anything survived), sampled token opaque, others translucent. Tooltips on nodes
gain a "sampler: X% / removed" line. The table gets a "sampler p / left" column.
`ensurePost()` runs after the toggle, after every run and after extensions; it
shares the `ctrl` guard, so Stop cancels it.

## Sankey encoding

One column per generated token, left to right. Lanes stack vertically, one per
run, `LANE` px each.

Column width encodes hesitation (`stepWidth`). A column is closed when its top
candidate holds at least `CLOSED_P` (0.85 by default; the "open a column when
the top pick is under" field under advanced, `#closed_p`, also `?closed_p=`,
changes it live): it is as wide as the sampled
token's label, shows no percentage and no candidate labels, so a confident
stretch reads like a line of text over a solid ribbon. Otherwise it is open:
wide enough for its candidate labels, between `OPEN_MIN` and `OPEN_MAX`.
A column is also closed when whitespace-only candidates together hold at least
`CLOSED_P` of the mass (`wsMass`): choosing between `\n` and `\n\n` is
formatting. A closed column is drawn quiet (`isQuiet`) when its sampled token is
only whitespace, punctuation or symbols (Unicode `\s`, `\p{P}`, `\p{S}`) or
when `wsMass` closed it: `CLOSED_MIN` wide, node at 35% opacity, ribbon at 45%,
label in muted ink. Punctuation of the trace, not a decision.
Widths are per global step, the max over all lanes (`layoutColumns`), so lanes
stay aligned. `colCur` tweens toward `colTarget` in the same `animate()` loop as
lane heights; new columns grow from 0. Step numbers are drawn on open columns
and every fifth column. Constants at the top of the UI
block: `H` (column height), `NODE_W`, `PITCH` (column spacing), `GAP`, `STUB`.

| Visual                          | Meaning                                                            |
|---------------------------------|--------------------------------------------------------------------|
| node height                     | probability; the column sums to 1 including the hatched "other"    |
| colored node (run's color)      | the token that was sampled in that run                             |
| candidate node in another color | a branch was forked from it; the ribbon leads to that lane         |
| gray node                       | a top-K candidate that was not sampled                             |
| hatched node (always last)      | mass outside the top-K (`remainder`)                               |
| ribbon to the next column       | the sampled node fans out to the full height of the next column, because the next distribution is conditional on it |
| fading stub                     | a branch not taken; the data holds nothing beyond it               |
| node order                      | probability desc, so a sampled node low in its column means the sampler picked a low-ranked token |
| fill opacity of the sampled node and its ribbon | hesitation, not probability (`emphasis`): 0.3 when the top candidate is near 1, full strength once it is under 40%, so sure stretches recede and deliberation stands out. Quiet columns stay at 0.35 |
| fine dotted outline (`rect.offtop`, `--ink-2` at 0.7, 1 px) | the sampled token was not the top candidate (`rank !== 0`): where randomness changed the text. Its tooltip names the top pick and its probability and says the sampler drew this one at the run's randomness, or that the top pick was blocked (`<think>` with thinking off). Not drawn on collapsed strips; selection uses a solid outline |

Only sampled and forked nodes have real flows. Everything else is a stub because
llama-server only returns the path it generated. Clicking a stub forks a branch.

The lane header (`TOP`) holds the lane label, then the output line
(`drawLine`), then the step numbers. The line prints each sampled token at its
column's x (`lineText`: quiet whitespace omitted, leading space dropped), so the
generated text reads left to right above the columns. Sub-word pieces are
joined (`groupWords`: pieces join when the boundary characters are letters or
digits, or a hyphen/apostrophe next to one, and the piece does not start with
whitespace): "K", "amp", "ala" becomes "Kampala" and "Île", "-de", "-F",
"rance" becomes "Île-de-France", drawn as one text run at the first column, one
`<tspan>` per piece, each carrying its step's `_info` for hover and click.
Folded lanes draw the same line beside their cells.

Labels: in open columns, the sampled node and any node at least `LABEL_MIN` px
tall get "token pct" beside the node. Closed columns have no node label; the
output line carries their token.
Leading space renders as a middle dot, newline as a return arrow (`vis()`).
Labels have a surface-colored halo (`paint-order: stroke`) so they stay legible
over ribbons.

## Rendering loop

`generate` calls `onStep` per token. The UI coalesces with `requestAnimationFrame`
and re-renders the whole SVG (`render()` clears and rebuilds). At a few hundred
steps this is cheap; if it stops being cheap, append columns instead of
rebuilding. The chart auto-scrolls to the newest column while streaming.

## Generation feedback

While a run generates (`run.generating`), the lane shows a pulsing dashed
outline where the next token will land, fed by the last node's ribbon, and
`layoutColumns` reserves 40 px for it; the output text ends in a blinking
caret; `body.busy` shows a spinner (`#spin`, a real element, not a
pseudo-element: rewriting the status text every token must not disturb it) and
highlights Stop. `setStatus` writes `#statusText`, never `#status` itself.
The status line counts tokens and tokens per second as they arrive
(`rateText`), and says "reading your prompt…" before the first one, which is
where a slow model spends its first seconds. Under `prefers-reduced-motion`
the pulse and caret stop; the spinner keeps turning, as the one busy cue.

## Lane collapse and animation

Each run has `collapsed` and an animated `laneH`. `animate()` tweens every
lane's `laneH` toward `LANE` (expanded) or `MINI` (collapsed; new lanes start at
0) and calls `render()` each frame until all lanes settle, so ribbons, fork links
and the SVG height follow without any per-element animation. `laneGeom(run)`
turns `laneH` into `f` (0..1), `top` and `colH`; columns scale by `f`, labels
fade out below `f = 0.55`, and at `f = 0` the lane renders as a strip of one
small cell per sampled token (opacity by probability) with the token text.
`prefers-reduced-motion` snaps instead of tweening.

Policy: forking a branch collapses every lane except the branch and its parent.
Click a lane label (or a collapsed cell) to toggle; "collapse" folds all but the
selected lane; "expand" opens all. Never animate by rebuilding DOM elsewhere;
add new motion by extending the tween state, so one loop owns all motion.

## Views and interaction

- Audience: people who do not know LLM terms. Visible controls use plain words
  (randomness, length, mode "continue my text" / "answer as an assistant",
  "think first", "run on"); every technical term stays behind "advanced" or in
  a `title` tooltip. Element ids keep their technical names (`temperature`,
  `n_predict`, `mode`, `think`, `engine`) so query strings and scripts are stable.
- `advanced()` (panel open) switches the app into technical mode: lane labels
  show full settings, tooltips add ids and logprobs, the status line appends
  tok/s and path logprob, and the table gains logprob and sampler columns.
  Keep this one switch; do not add per-feature "show technical" toggles.
- Controls: prompt textarea, Run (primary; Ctrl+Enter or Cmd+Enter), Stop
  (Escape), randomness slider, length, mode, think first, run on. Choosing the
  browser engine reveals a model row (curated public URLs, or a URL) with a load
  button, a size note (a warning above 1 GB) and progress. Advanced: server
  URL, candidates per step (n_probs), top_k, top_p, min_p, seed, the
  closed-column threshold, "add a run to compare", "show sampler filtering".
- Text strip: one row per run, prompt in muted ink, then each step's `text`.
  It scrolls, is selectable, and each token is hoverable (tooltip) and
  clickable (select the step, expand its lane, scroll the chart to its column).
- Tooltip (`#tip`, fixed position): token, id, p, logprob, rank, cumulative path
  logprob for sampled nodes. Nodes thinner than 12 px get an invisible enlarged hit rect.
- Click a sampled node to select its step (outlined in the strip and the table); click again to clear.
- Click a gray candidate to branch from it. Click a candidate already branched to select that lane.
- Legend lists runs with their settings and fork origin; click to select a lane.
- "table view" swaps the chart for a table with one row per step and the full
  candidate list. It is the accessibility fallback for the chart.
- "compare runs" is on by default (`?compare=0` turns it off) and shows nothing
  until there are two runs. It compares two runs that share a prompt.
  `compareData()` builds it: `pathOf(run)` rebuilds a run's full token path by
  global step by walking up the branch chain (the forced candidate at the fork
  carries the probability its parent reported for it), and the divergence step
  is the first position where the two paths differ by token text (text, not
  id, so runs on different models still line up where they agree). `render()` then appends
  three tracks under the lanes inside the Sankey SVG (`drawCompare`, height
  `CMP_H`), so they share the column x positions and scroll with the runs, in
  the two run colors: same token or not (one gray cell, or a cell split in the
  two colors), hesitation per step as bars of Shannon entropy in bits of the
  reported distribution (top-K plus the tail as one bucket, so a lower bound),
  and the accumulated path logprob since the split as one line per run with the
  gap shaded. The panel under the chart (`#compare`, `renderCompare()`) holds
  the two run selects and a summary sentence: positional token matches, shared
  distinct tokens, mean hesitation, and path logprobs over the same number of
  steps so a longer run is not penalised, with the likelihood ratio. In
  advanced mode the panel adds the numbers as a table. Default pair: the
  selected branch and its parent, else the latest branch and its parent, else
  the first two runs; the selects override it. Semantic divergence (embedding
  distance between the two continuations) is not implemented; see plan.md.
- Query string: any control id as a parameter prefills it (`base`, `prompt`,
  `n_predict`, `n_probs`, `temperature`, `top_k`, `top_p`, `min_p`, `seed`,
  `closed_p`; `chat=1` selects assistant mode, `think=1`, `post=1`,
  `advanced=1`, `compare=0` hides the compare view, which is on by default; `engine=browser` plus
  optional `model=<url>` loads a model first); `run=1` starts a run on load; `branch=<step>:<rank>` or
  `branch=<step>:<token text>` (repeatable) then forks the first run at that
  global step taking the rank-th unchosen candidate, or the candidate whose
  trimmed token matches. Used by `scripts/shot.ts`.
