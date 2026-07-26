import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";

await rm("dist", { recursive: true, force: true });
await mkdir("dist/server", { recursive: true });
await mkdir("dist/.openai", { recursive: true });
await Promise.all([
  cp("index.html", "dist/index.html"),
  cp("config.js", "dist/config.js"),
  cp(".openai/hosting.json", "dist/.openai/hosting.json"),
]);

const [html, config] = await Promise.all([
  readFile("index.html", "utf8"),
  readFile("config.js", "utf8"),
]);

await writeFile("dist/server/index.js", `
const html = ${JSON.stringify(html)};
const config = ${JSON.stringify(config)};

export default {
  async fetch(request) {
    const { pathname } = new URL(request.url);
    if (pathname === "/config.js") {
      return new Response(config, {
        headers: {
          "content-type": "text/javascript; charset=utf-8",
          "cache-control": "no-cache",
        },
      });
    }
    return new Response(html, {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-cache",
      },
    });
  },
};
`);
