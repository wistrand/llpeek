// Static server for docs/ (the GitHub Pages site: landing page at /, app at /app.html).
// No dependencies. `deno task serve`, PORT env to change the port.
// Sends COOP/COEP headers so wllama can use SharedArrayBuffer (multi-threaded WASM);
// on Pages the service worker in docs/ does the same job.
const port = Number(Deno.env.get("PORT") ?? 8000);
const root = new URL("../docs/", import.meta.url);
// PAGES=1 emulates GitHub Pages: no local flag (browser engine only) and no
// COOP/COEP headers, so the service worker has to provide isolation.
const PAGES = Deno.env.get("PAGES") === "1";
const types: Record<string, string> = {
  html: "text/html; charset=utf-8", js: "text/javascript", mjs: "text/javascript", ts: "text/plain",
  json: "application/json", css: "text/css", png: "image/png", svg: "image/svg+xml", ico: "image/x-icon", txt: "text/plain",
};
const headers: Record<string, string> = PAGES ? { "cache-control": "no-store" } : {
  "cache-control": "no-store",
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-embedder-policy": "credentialless",
};

// The app offers the llama-server engine only when served by this script: a
// flag is injected into app.html on the way out (the file on disk is what
// GitHub Pages serves, where no server can exist).
const LOCAL_FLAG = "<script>window.LLPEEK_LOCAL = true;</script>";

Deno.serve({ port, hostname: "127.0.0.1" }, async (req) => {
  let path = decodeURIComponent(new URL(req.url).pathname);
  if (path === "/") path = "/index.html";
  if (path.includes("..")) return new Response("bad path", { status: 400, headers });
  try {
    const ext = path.split(".").pop() ?? "";
    const type = types[ext] ?? "application/octet-stream";
    if (path === "/app.html" && !PAGES) {
      const html = (await Deno.readTextFile(new URL("./app.html", root))).replace("<head>", "<head>\n" + LOCAL_FLAG);
      return new Response(html, { headers: { ...headers, "content-type": type } });
    }
    const file = await Deno.readFile(new URL("." + path, root));
    return new Response(file, { headers: { ...headers, "content-type": type } });
  } catch {
    return new Response("not found", { status: 404, headers });
  }
});
console.log(`Listening on http://127.0.0.1:${port}/${PAGES ? "  (PAGES=1: emulating GitHub Pages, browser engine only)" : ""}`);
