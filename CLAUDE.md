Guidance for agents working in this repo. Read this first, then the relevant
file in `agent_docs/`.

## What this is

llpeek (Large Language Peek, pronounced "peek"; formerly llview, renamed because Jülich's LLview HPC monitor owns that name) visualizes an LLM's per-token decision steps: for every generated token,
the candidates the model considered and their probabilities. Inference is done by
llama.cpp's `llama-server`; llpeek only consumes its HTTP API (`n_probs` /
`logprobs`) and renders. There is no custom inference code in this repo.

```
prompt --> llama-server (/completion, n_probs=K, stream) --> per-token top-K logprobs --> llpeek UI
```

## Related project

Companion of `../llav` (github.com/wistrand/llav): an HTTP server that answers
decision questions by reading next-token logprobs through llama-server, with a
wllama browser demo in `docs/demo/`. Shared with llpeek: the llama.cpp and
wllama stack, the GGUF files in `~/models`, and the interest in per-token
probabilities. Not shared: code. When a llama-server or wllama finding here
would matter to llav (API quirks, model behavior, browser limits), say so in
the final message so the user can carry it over; do not edit `../llav`.

## Layout

| Path                 | Role                                                                    |
|----------------------|-------------------------------------------------------------------------|
| `docs/app.html`      | the whole app: first `<script>` is the data layer (`llpeek`), the rest is the UI |
| `deno.json`          | tasks: `llama`, `serve`, `pages`, `dev`, `check`, `shot`, `headless`, `model` |
| `scripts/serve.ts`   | static server for `docs/` with COOP/COEP headers (no deps)              |
| `scripts/headless.ts`| open a URL in headless Chrome: print `#out` once it says DONE/ERROR, or wait for the app to settle and print a JS expression (async ones are awaited) |
| `scripts/models.ts`  | list/download known GGUFs into `~/models` (resume, size check)           |
| `scripts/wllama-probe.html` | probe page for the in-browser engine's API behavior                |
| `scripts/check.mjs`  | headless check of the data layer against a running llama-server         |
| `scripts/shot.ts`    | headless Chrome screenshots (light and dark) after a run                 |
| `docs/`              | the whole site, served locally by `deno task serve` and published by GitHub Pages: `index.html` (landing page), `app.html` (the app), `favicon.svg` (linked from both pages, dark-mode aware), `coi-serviceworker.js`, `.nojekyll`, screenshots (`deno task shot`) and thumbnails (`magick screenshot-*.png -resize 50% thumb-*.png`) |
| `agent_docs/`        | per-topic deep dives (linked below)                                     |
| `README.md`          | human-facing overview and quick start                                   |
| `~/models/`          | GGUF models (outside the repo, never copy them in)                      |

Stack decision: a single static HTML file, no build step, no generated copies.
`docs/` is both the local dev root and the published site. The only runtime
dependencies are wllama and @huggingface/jinja, loaded from jsdelivr on demand
when the user picks the in-browser engine; the llama-server path has none. Deno
is used only for tasks and helper scripts. The first `<script>` in
`docs/app.html` is the pure data layer (no `document` access); `scripts/check.mjs`
extracts and loads only that block.

## Commands

```bash
deno task model [name..]   # list known models / download into ~/models (e.g. deno task model qwen3.5-2b)
deno task llama            # llama-server on :8089, 2B Qwen; append flags to override (-m, --port, -c)
deno task serve            # docs/ on http://localhost:8000: landing page at /, app at /app.html (PORT env overrides)
deno task pages            # same, but emulating GitHub Pages: no server engine, no isolation headers
deno task dev              # both
deno task check [base]     # data-layer check against a running llama-server (default :8089)
deno task shot [url] [dir] # light+dark screenshots after a run; default url http://localhost:8000/app.html?run=1, dir docs/
deno task headless <url> [secs] [js-expr]  # headless Chrome: print a probe page's #out, or, with an expression, wait for the app to settle and print its value (e.g. legend titles, status); an async expression is awaited, so it can click and wait

# raw probe
curl -s localhost:8089/completion -d '{"prompt":"Hello","n_predict":3,"n_probs":5}' | python3 -m json.tool
```

The page reads its fields from the query string (`?base=&prompt=&n_predict=&n_probs=&temperature=&top_k=&top_p=&min_p=&seed=&closed_p=`, plus `chat=1`, `think=1`, `post=1`, `advanced=1`, `compare=0` (the compare view is on by default), `zoom=<factor>`, `engine=browser&model=<url>`), `run=1` auto-runs, `branch=<step>:<rank>` forks the first run afterwards, and `resample=<step>:<n>` then redraws that step of the first run n times. Full list in architecture-app.md.

Any new terminal status message must contain "done", "error", "stopped" or "ready", or `scripts/headless.ts` and `scripts/shot.ts` never see the page as idle. Verifying a change, cheapest first: parse both script blocks with node, run `deno task check`, then `deno task headless "http://localhost:<port>/app.html?run=1&..." 10` to catch runtime exceptions (it prints console errors), or with a third argument to read a DOM value after the run (legend titles show each run's effective params). Screenshots are overkill for most changes; take one only for a layout change, and read it. Probe servers: llama-server on 18099 (capture its PID with `$!` and kill only that PID; the user's own server on 8089 must survive) and the static server on another port. Browser-engine probes re-download the model every headless run: use stories260K for plumbing and SmolLM2 360M (0.4 GB) when the output has to make sense.

## Docs

- [agent_docs/architecture-llama-server.md](agent_docs/architecture-llama-server.md): the llama-server API contract llpeek depends on. Verified response shapes for `/completion`, streaming, `/v1/completions`, `/tokenize`, `/props`.
- [agent_docs/architecture-app.md](agent_docs/architecture-app.md): the page itself: engines, step model, runs and branching, Sankey geometry, the rendering loop.
- [agent_docs/architecture-browser-engine.md](agent_docs/architecture-browser-engine.md): the wllama engine: loading, response format, what differs from llama-server and how it is bridged, COOP/COEP.
- [agent_docs/plan.md](agent_docs/plan.md): roadmap for the visualizer, decisions pending, phases.
- [agent_docs/gotchas.md](agent_docs/gotchas.md): traps in the llama-server API and this machine's setup. Skim before touching request parameters or sampling settings.

## Invariants

- All model access goes through an engine object (`serverEngine` or `browserEngine`) with the surface documented in architecture-app.md. No inference code lives in this repo; wllama is llama.cpp compiled to WASM.
- On the server engine use the native `/completion` endpoint, not `/v1/completions`, for logprob data. It carries token ids and the streaming form delivers per-token candidates as they are generated.
- Probabilities shown as "what the model thought" come from `n_probs` (pre-sampling logprobs), never from `post_sampling_probs`. See gotchas for why.
- Models stay in `~/models` for llama-server, and come from public URLs for the browser engine. Never commit or copy a GGUF into the repo, and never serve `~/models` from the static server.
- Never start a multi-GB model download on your own; `deno task model` is for the user to run. Test the script with `stories260k` into a scratch dir: `deno run --allow-net --allow-env=HOME --allow-read=<dir> --allow-write=<dir> scripts/models.ts --dir <dir> stories260k`.
- `docs/app.html` stays a single file with no build step. External code is loaded only for the browser engine: wllama's JS module once the browser engine is selected (to read which models its cache holds), the runtime, WASM and jinja only when a model is loaded. The server path loads nothing external. The first `<script>` (data layer) must not touch `document`, or `scripts/check.mjs` breaks.
- Links inside `docs/` stay relative, so the same files work at `http://localhost:8000/` and at `https://<user>.github.io/llpeek/`.
- The llama-server engine exists only when `scripts/serve.ts` serves the page (it injects `window.LLPEEK_LOCAL`). Anything that needs the server engine (check, shot, headless runs with `base=`) must go through that server, never through another static server or `file://`.
- Every column of the Sankey sums to 1 including the hatched "other" node. Never drop the tail to make the chart look tidier; it is the honest part.

## Conventions

- Keep the layout as stable as possible. Nothing should move, grow or shrink
  when state changes (a run starts or ends, a note appears, a model loads):
  reserve the space up front, size rows from the input rather than from
  content, scroll inside boxes instead of growing them, and toggle
  visibility rather than display. Check a before/after pair of screenshots
  or element sizes for any layout change.

- Never run `deno fmt` or `deno lint`.
- Never run tests, and never run anything with interactive output.
- Never install packages; write a script for the user instead.
- Port 8080 is taken by an unrelated service on this machine; the project default for llama-server is 8089. Agents run probes on 18099 so they never collide with the user's own server, and kill it when done.
- Use the 2B Qwen model for probes and development. Larger models only when the user asks.
- Colors follow the dataviz reference palette (blue `#2a78d6`/`#3987e5` for the sampled path, neutral gray for candidates not taken, hatch for the tail). Define new colors as `:root` tokens with dark-mode values under both the media query and `[data-theme="dark"]`.

## Documentation Style

- Markdown links for doc references you want an agent to follow, not backticks.
  Backticks are fine for source paths in tables and inline code. Align table columns.
- No AI-isms (no "powerful", "seamlessly", "leverage", rule-of-three, "not just
  X but Y"). No em dashes or emojis in project copy. State the point directly.
- Concise; assume the agent is competent. Add only what it can't infer (project
  names, rules, constraints, and the why). Cut explanations of general concepts.
- State each rule on its own line as always/never; a rule buried mid-paragraph gets skipped.
- Mark inferred claims and open questions; don't present a guess as a fact.
- Keep this file the routing entry point; move subsystem detail into agent_docs/.
- Response shapes in agent_docs are captured from a real server run. When llama.cpp is upgraded, re-probe and update them rather than trusting memory.
