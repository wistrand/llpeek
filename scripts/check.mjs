// Headless check of the data layer in docs/app.html against a running llama-server.
// Usage: deno task check [base-url]   (default http://localhost:8089); also runs under node.
// Extracts the first <script> from docs/app.html, loads the pure `llpeek` object,
// runs the reference prompt, and compares the parsed steps with a direct
// non-stream /completion of the same request.
import fs from 'node:fs';
import process from 'node:process';
const base = process.argv[2] || 'http://localhost:8089';

const html = fs.readFileSync(new URL('../docs/app.html', import.meta.url), 'utf8');
const src = html.match(/<script>([\s\S]*?)<\/script>/)[1];
const m = { exports: {} };
new Function('module', 'document', src)(m, undefined);
const llpeek = m.exports;

const req = { prompt: 'The capital of France is', n_predict: 6, n_probs: 5, temperature: 0, seed: 1 };

(async () => {
  console.log('health', await llpeek.health(base));
  const toks = await llpeek.tokenize(base, req.prompt);
  console.log('prompt tokens', toks.map((t) => t.piece));

  const engine = llpeek.serverEngine(base);
  const { steps, final } = await llpeek.generate(engine, req, null);
  console.log('stream steps', steps.length, 'stop_type', final.stop_type);
  for (const s of steps) {
    console.log(`#${s.index} ${JSON.stringify(s.text)} p=${s.prob.toFixed(3)} rank=${s.rank} other=${s.remainder.toFixed(3)}`,
      s.candidates.map((c) => `${c.token}:${c.prob.toFixed(3)}`).join(' '));
  }

  // Reference: same request, non-streamed, compared field by field.
  const r = await fetch(`${base}/completion`, { method: 'POST', body: JSON.stringify(req) });
  const ref = await r.json();
  const refSteps = ref.completion_probabilities.map(llpeek.stepFrom);
  llpeek.mergeText(refSteps);
  let ok = refSteps.length === steps.length;
  for (let i = 0; ok && i < steps.length; i++) {
    const a = steps[i], b = refSteps[i];
    ok = a.id === b.id && a.logprob === b.logprob && a.text === b.text &&
      a.candidates.length === b.candidates.length &&
      a.candidates.every((c, j) => c.id === b.candidates[j].id && c.logprob === b.candidates[j].logprob);
  }
  console.log('text', JSON.stringify(steps.map((s) => s.text).join('')), '| ref', JSON.stringify(ref.content));
  console.log(ok ? 'OK: stream matches non-stream reference' : 'MISMATCH');
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(2); });
