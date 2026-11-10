import { readFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const html = await readFile(resolve(root, "dist/index.html"), "utf8");
const logo = await readFile(resolve(root, "dist/aquamind-logo.png"));
const template = await readFile(resolve(root, "worker/worker.template.js"), "utf8");
const worker = template
  .replace("__APP_HTML__", JSON.stringify(html))
  .replace("__LOGO_BYTES__", `Uint8Array.from(atob("${logo.toString("base64")}"), c => c.charCodeAt(0))`);
const output = resolve(root, "dist/server/index.js");
await mkdir(dirname(output), { recursive: true });
await writeFile(output, worker);
await mkdir(resolve(root, "dist/.openai"), { recursive: true });
await writeFile(resolve(root, "dist/.openai/hosting.json"), JSON.stringify(JSON.parse(await readFile(resolve(root, ".openai/hosting.json"), "utf8")), null, 2) + "\n");
console.log(`Built ${output}`);
