import { copyFile, readdir, readFile, stat, unlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const root = resolve(
  scriptDirectory,
  "../../src/host_monitor/static/dashboard",
);
const assets = resolve(root, "assets");
const html = await readFile(resolve(root, "index.html"), "utf8");
const current = new Set(
  [...html.matchAll(/\/assets\/([^"'?]+)/g)].map(match => match[1]),
);
const files = await Promise.all(
  (await readdir(assets)).map(async name => ({
    name,
    modified: (await stat(resolve(assets, name))).mtimeMs,
  })),
);

for (const extension of [".js", ".css"]) {
  const candidates = files
    .filter(file => file.name.endsWith(extension))
    .sort((left, right) => right.modified - left.modified);
  const previous = candidates.find(file => !current.has(file.name));
  if (previous) current.add(previous.name);
}

await Promise.all(
  files
    .filter(
      file =>
        (file.name.endsWith(".js") || file.name.endsWith(".css")) &&
        !current.has(file.name),
    )
    .map(file => unlink(resolve(assets, file.name))),
);

await copyFile(
  resolve(scriptDirectory, "../src/config/dashboard.json"),
  resolve(root, "dashboard.json"),
);
