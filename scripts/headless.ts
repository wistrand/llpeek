// Open a URL in headless Chrome and print a result once the page settles.
// Usage: deno task headless <url> [timeout-seconds] [expression]
//   default: wait until #out's text starts with DONE or ERROR, print it (probe pages)
//   with expression: wait until the app is idle (Stop disabled, status settled),
//   then print the value of the JS expression (e.g. a legend or status readout)
const pageUrl = Deno.args[0];
const timeout = Number(Deno.args[1] ?? 180);
const expr = Deno.args[2];
const port = 19223;
const chrome = new Deno.Command("google-chrome-stable", {
  args: ["--headless=new", "--no-sandbox", `--remote-debugging-port=${port}`, "--enable-unsafe-webgpu", "--enable-features=Vulkan", "about:blank"],
  stdout: "null", stderr: "null",
}).spawn();
async function target(): Promise<string> {
  for (let i = 0; i < 50; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
      const t = list.find((t: { type: string }) => t.type === "page");
      if (t) return t.webSocketDebuggerUrl;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("chrome did not start");
}
const ws = new WebSocket(await target());
await new Promise((r) => ws.onopen = r);
let id = 0;
const pending = new Map<number, (v: any) => void>();
const logs: string[] = [];
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)!(m); pending.delete(m.id); }
  if (m.method === "Runtime.consoleAPICalled" && (m.params.type === "error" || m.params.type === "warning")) logs.push(m.params.args.map((a: any) => a.value ?? a.description).join(" "));
  if (m.method === "Runtime.exceptionThrown") logs.push("EXCEPTION " + m.params.exceptionDetails.text + " " + (m.params.exceptionDetails.exception?.description ?? ""));
};
const send = (method: string, params = {}) =>
  new Promise<any>((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
const evaluate = async (expression: string) => (await send("Runtime.evaluate", { expression, returnByValue: true })).result?.result?.value;
await send("Page.enable"); await send("Runtime.enable");
await send("Page.navigate", { url: pageUrl });
let text = "";
const t0 = Date.now();
while (Date.now() - t0 < timeout * 1000) {
  await new Promise((r) => setTimeout(r, 500));
  if (expr) {
    const busy = await evaluate("!!document.getElementById('stop') && !document.getElementById('stop').disabled");
    const status = (await evaluate("document.getElementById('status')?.textContent ?? ''")) ?? "";
    if (!busy && /done|error|stopped|ready|Nothing to extend|using the llama-server|no llama-server|no local llama-server/i.test(status)) { text = String(await evaluate(expr)); break; }
    continue;
  }
  text = (await evaluate("document.getElementById('out')?.textContent ?? ''")) ?? "";
  if (/^(DONE|ERROR)/.test(text)) break;
}
if (!text && expr) text = "(timeout) " + String(await evaluate(expr));
console.log(text || "(timeout, no output)");
if (logs.length) console.log("--- console errors/warnings ---\n" + logs.slice(0, 20).join("\n"));
ws.close(); chrome.kill();
