// Download GGUF models into ~/models. No dependencies.
//   deno task model                 list known models and what is already present
//   deno task model <name> [...]    download by name (see list) or by URL
// Downloads go to <file>.part with HTTP range resume, then rename. A file whose
// size already matches the server's is skipped. `--dir <path>` changes the
// target (then run the script directly with matching --allow-read/--allow-write).
const args = [...Deno.args];
let dir = `${Deno.env.get("HOME")}/models`;
const di = args.indexOf("--dir");
if (di >= 0) { dir = args[di + 1]; args.splice(di, 2); }
dir = dir.replace(/\/$/, "");
const HF = "https://huggingface.co";
const KNOWN: Record<string, { url: string; note: string }> = {
  "qwen3.5-2b":        { url: `${HF}/bartowski/Qwen_Qwen3.5-2B-GGUF/resolve/main/Qwen_Qwen3.5-2B-Q8_0.gguf`, note: "2.1 GB, Q8_0, the server default" },
  "qwen3.5-2b-q4":     { url: `${HF}/bartowski/Qwen_Qwen3.5-2B-GGUF/resolve/main/Qwen_Qwen3.5-2B-Q4_K_M.gguf`, note: "1.4 GB, Q4_K_M, the browser default" },
  "qwen3.5-4b":        { url: `${HF}/bartowski/Qwen_Qwen3.5-4B-GGUF/resolve/main/Qwen_Qwen3.5-4B-Q8_0.gguf`, note: "4.6 GB, Q8_0" },
  "qwen3.5-4b-q4":     { url: `${HF}/bartowski/Qwen_Qwen3.5-4B-GGUF/resolve/main/Qwen_Qwen3.5-4B-Q4_K_M.gguf`, note: "3.0 GB, Q4_K_M" },
  "smollm3":           { url: `${HF}/ggml-org/SmolLM3-3B-GGUF/resolve/main/SmolLM3-Q8_0.gguf`, note: "3.3 GB, Q8_0, thinking model with a system-prompt style template" },
  "smollm3-q4":        { url: `${HF}/ggml-org/SmolLM3-3B-GGUF/resolve/main/SmolLM3-Q4_K_M.gguf`, note: "1.9 GB, Q4_K_M, fits the browser" },
  "granite-4.0-h-tiny":{ url: `${HF}/ibm-granite/granite-4.0-h-tiny-GGUF/resolve/main/granite-4.0-h-tiny-Q8_0.gguf`, note: "7.4 GB, Q8_0, hybrid mamba/transformer MoE" },
  "granite-4.2-3b":    { url: `${HF}/ibm-granite/granite-4.2-3b-GGUF/resolve/main/granite-4.2-3b-Q8_0.gguf`, note: "3.9 GB, Q8_0" },
  "smollm2-360m":      { url: `${HF}/HuggingFaceTB/SmolLM2-360M-Instruct-GGUF/resolve/main/smollm2-360m-instruct-q8_0.gguf`, note: "0.4 GB, Q8_0, small and fast; in the browser list" },
  "gemma3-1b":         { url: `${HF}/ggml-org/gemma-3-1b-it-GGUF/resolve/main/gemma-3-1b-it-Q8_0.gguf`, note: "1.1 GB, Q8_0; in the browser list" },
  "llama3.2-1b":       { url: `${HF}/bartowski/Llama-3.2-1B-Instruct-GGUF/resolve/main/Llama-3.2-1B-Instruct-Q8_0.gguf`, note: "1.3 GB, Q8_0; in the browser list" },
  "qwen2.5-coder-1.5b": { url: `${HF}/bartowski/Qwen2.5-Coder-1.5B-Instruct-GGUF/resolve/main/Qwen2.5-Coder-1.5B-Instruct-Q8_0.gguf`, note: "1.6 GB, Q8_0, code model; in the browser list" },
  "qwen2.5-coder-3b-q4": { url: `${HF}/bartowski/Qwen2.5-Coder-3B-Instruct-GGUF/resolve/main/Qwen2.5-Coder-3B-Instruct-Q4_K_M.gguf`, note: "1.9 GB, Q4_K_M, code model; in the browser list" },
  "qwen2.5-coder-3b":   { url: `${HF}/bartowski/Qwen2.5-Coder-3B-Instruct-GGUF/resolve/main/Qwen2.5-Coder-3B-Instruct-Q8_0.gguf`, note: "3.3 GB, Q8_0, code model, server only" },
  "stories260k":       { url: `${HF}/ggml-org/models/resolve/main/tinyllamas/stories260K.gguf`, note: "1 MB, toy model for testing the tooling" },
};

const fileOf = (url: string) => decodeURIComponent(url.split("/").pop()!);
const gb = (n: number) => n >= 1e9 ? `${(n / 1e9).toFixed(2)} GB` : `${(n / 1e6).toFixed(1)} MB`;

async function localSize(path: string): Promise<number> {
  try { return (await Deno.stat(path)).size; } catch { return -1; }
}

async function download(url: string) {
  const name = fileOf(url), dest = `${dir}/${name}`, part = `${dest}.part`;
  const head = await fetch(url, { method: "HEAD", redirect: "follow" });
  if (!head.ok) throw new Error(`${url}: HTTP ${head.status}`);
  const total = Number(head.headers.get("content-length") ?? 0);
  if (await localSize(dest) === total && total > 0) { console.log(`${name}: already present (${gb(total)})`); return; }
  let have = await localSize(part); if (have < 0) have = 0;
  if (have >= total && total > 0) have = 0;
  const res = await fetch(url, { redirect: "follow", headers: have ? { range: `bytes=${have}-` } : {} });
  if (!res.ok || !res.body) throw new Error(`${url}: HTTP ${res.status}`);
  if (res.status !== 206) have = 0;
  const file = await Deno.open(part, { write: true, create: true, append: res.status === 206, truncate: res.status !== 206 });
  console.log(`${name}: ${have ? `resuming at ${gb(have)}` : "downloading"} of ${gb(total)} -> ${dest}`);
  let done = have, last = Date.now(), lastDone = have;
  const t0 = Date.now();
  for await (const chunk of res.body) {
    await file.write(chunk); done += chunk.byteLength;
    if (Date.now() - last > 2000) {
      const rate = (done - lastDone) / ((Date.now() - last) / 1000);
      console.log(`  ${gb(done)} / ${gb(total)}  ${(100 * done / total).toFixed(0)}%  ${(rate / 1e6).toFixed(0)} MB/s`);
      last = Date.now(); lastDone = done;
    }
  }
  file.close();
  if (total && done !== total) throw new Error(`${name}: got ${done} bytes, expected ${total}; rerun to resume`);
  await Deno.rename(part, dest);
  console.log(`${name}: done in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
}

await Deno.mkdir(dir, { recursive: true });
if (!args.length) {
  console.log(`models directory: ${dir}\n`);
  for (const [k, v] of Object.entries(KNOWN)) {
    const size = await localSize(`${dir}/${fileOf(v.url)}`);
    console.log(`${k.padEnd(20)} ${size > 0 ? "present" : "       "}  ${v.note}`);
  }
  console.log(`\nusage: deno task model <name|url> [...]`);
} else {
  for (const a of args) {
    const url = KNOWN[a]?.url ?? (a.startsWith("http") ? a : null);
    if (!url) { console.error(`unknown model "${a}"; run without arguments for the list`); Deno.exit(1); }
    await download(url);
  }
}
