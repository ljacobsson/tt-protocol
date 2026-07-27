import {createReadStream, existsSync, statSync} from "node:fs";
import {createServer} from "node:http";
import {extname, join, normalize} from "node:path";

const root = process.cwd();
const port = Number(process.env.MATCHPROTOKOLL_PORT || 8001);
const types = {
  ".css":"text/css; charset=utf-8",
  ".html":"text/html; charset=utf-8",
  ".js":"text/javascript; charset=utf-8",
  ".json":"application/json; charset=utf-8",
  ".mp4":"video/mp4",
  ".png":"image/png",
  ".svg":"image/svg+xml",
  ".txt":"text/plain; charset=utf-8",
  ".xml":"application/xml; charset=utf-8"
};

createServer((request, response) => {
  let pathname = "/";
  try{ pathname = decodeURIComponent(new URL(request.url, "http://localhost").pathname); }
  catch(error){ response.writeHead(400).end("Bad request"); return; }

  const relative = normalize(pathname).replace(/^(\.\.(\/|\\|$))+/, "").replace(/^[/\\]+/, "");
  let file = join(root, relative || "index.html");
  if (!file.startsWith(root) || !existsSync(file) || !statSync(file).isFile())
    file = join(root, "index.html");

  response.setHeader("Content-Type", types[extname(file).toLowerCase()] || "application/octet-stream");
  response.setHeader("Cache-Control", file.endsWith("index.html") ? "no-cache" : "public, max-age=3600");
  createReadStream(file)
    .on("error", () => response.writeHead(500).end("Server error"))
    .pipe(response);
}).listen(port, () => {
  console.log(`Matchprotokoll körs på http://localhost:${port}`);
});
