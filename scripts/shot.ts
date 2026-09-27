// Screenshot the app after a generation finishes, in light and dark mode.
// Usage: deno task shot [page-url] [out-dir]
//   page-url defaults to http://localhost:8000/app.html?run=1 (add &base=... to point at another llama-server)
// Drives google-chrome-stable over the DevTools protocol; no dependencies.
const pageUrl = Deno.args[0] ?? "http://localhost:8000/app.html?run=1";
const outDir = Deno.args[1] ?? "docs";
const port = 19222;

const chrome = new Deno.Command("google-chrome-stable", {
  args: ["--headless=new", "--disable-gpu", "--no-sandbox", "--hide-scrollbars",
    `--remote-debugging-port=${port}`, "--window-size=1400,900", "about:blank"],
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
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)!(m); pending.delete(m.id); } };
const send = (method: string, params = {}) =>
  new Promise<any>((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
const evaluate = async (expression: string) => (await send("Runtime.evaluate", { expression, returnByValue: true })).result?.result?.value;

await send("Page.enable"); await send("Runtime.enable");
await Deno.mkdir(outDir, { recursive: true });
for (const scheme of ["light", "dark"]) {
  await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: scheme }] });
  await send("Page.navigate", { url: pageUrl });
  // Wait until nothing is generating (Stop disabled) and the status is settled.
  let status = "";
  for (let i = 0; i < 600; i++) {
    await new Promise((r) => setTimeout(r, 250));
    if (!(await evaluate("!!document.getElementById('status')"))) { status = "(static page)"; await new Promise((r) => setTimeout(r, 750)); break; }
    status = await evaluate("document.getElementById('status')?.textContent ?? ''") ?? "";
    const busy = await evaluate("!document.getElementById('stop').disabled");
    if (busy) continue;
    if (/done|error|stopped|ready|nothing to extend/.test(status) || (status === "idle" && !pageUrl.includes("run=1"))) break;
  }
  console.log(`${scheme}: ${status}`);
  // Full-page capture: size the clip to the document so nothing below the fold is lost.
  const metrics = await send("Page.getLayoutMetrics");
  const size = metrics.result?.cssContentSize ?? metrics.result?.contentSize ?? { width: 1400, height: 900 };
  const shot = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true,
    clip: { x: 0, y: 0, width: Math.ceil(size.width), height: Math.ceil(size.height), scale: 1 } });
  const file = `${outDir}/screenshot-${scheme}.png`;
  await Deno.writeFile(file, Uint8Array.from(atob(shot.result.data), (c) => c.charCodeAt(0)));
  console.log(`wrote ${file}`);
}
ws.close();
chrome.kill();
