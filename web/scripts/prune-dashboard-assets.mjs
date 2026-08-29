import { copyFile, readdir, readFile, stat, unlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const root = resolve(
  scriptDirectory,
  process.argv[2] ?? "../../src/host_monitor/static/dashboard",
);
const dashboardSource = resolve(
  scriptDirectory,
  process.argv[3] ?? "../src/config/dashboard.json",
);
const retainPrevious = process.argv[4] !== "false";
const assets = resolve(root, "assets");
const html = await readFile(resolve(root, "index.html"), "utf8");
const current = new Set(
  [...html.matchAll(/\/assets\/([^"'?]+)/g)].map(match => match[1]),
);

async function includeDependencies() {
  for (const name of [...current]) {
    if (!name.endsWith(".js")) continue;
    const source = await readFile(resolve(assets, name), "utf8");
    for (const match of source.matchAll(/assets\/([^"'?]+)/g)) {
      current.add(match[1]);
    }
  }
}
await includeDependencies();
const files = await Promise.all(
  (await readdir(assets)).map(async name => ({
    name,
    modified: (await stat(resolve(assets, name))).mtimeMs,
  })),
);

if (retainPrevious) {
  for (const extension of [".js", ".css"]) {
    const candidates = files
      .filter(file => file.name.endsWith(extension))
      .sort((left, right) => right.modified - left.modified);
    const previous = candidates.find(file => !current.has(file.name));
    if (previous) current.add(previous.name);
  }
  await includeDependencies();
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
  dashboardSource,
  resolve(root, "dashboard.json"),
);
