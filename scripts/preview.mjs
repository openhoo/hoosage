import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
const routes = {
  "/": [
    "text/html",
    '<!doctype html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'self\'; script-src \'nonce-hoosage-preview\'; img-src \'self\' data:; font-src \'self\';"><title>hoosage — UI preview</title><link rel="stylesheet" href="/app.css"></head><body><div id="app"></div><script nonce="hoosage-preview" src="/webview.js"></script></body></html>',
  ],
  "/app.css": ["text/css", "media/app.css"],
  "/webview.js": ["text/javascript", "dist/webview.js"],
};
const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const route = routes[url.pathname];
  if (!route) {
    res.writeHead(404).end();
    return;
  }
  res.writeHead(200, { "Content-Type": route[0] });
  const theme =
    url.searchParams.get("theme") === "light" ? "vscode-light" : "vscode-dark";
  res.end(
    url.pathname === "/"
      ? route[1].replace("<body>", `<body class="${theme}">`)
      : await readFile(route[1]),
  );
});
server.listen(4173, "127.0.0.1", () =>
  console.log("hoosage preview: http://127.0.0.1:4173"),
);
