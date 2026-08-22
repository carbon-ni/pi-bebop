import { readFile } from "node:fs/promises";
import path from "node:path";

const packagePath = path.resolve("package.json");
const source = await readFile(packagePath, "utf8");
const packageJson = JSON.parse(source);
const devDependencies = source.match(/"devDependencies"\s*:\s*\{([\s\S]*?)\n\s*\}/)?.[1];
if (!devDependencies) throw new Error("package.json is missing devDependencies");
const names = [...devDependencies.matchAll(/^\s*"([^"]+)"\s*:/gm)].map((match) => match[1]);
const duplicates = names.filter((name, index) => names.indexOf(name) !== index);
if (duplicates.length > 0) throw new Error(`Duplicate devDependency keys: ${[...new Set(duplicates)].join(", ")}`);
if (packageJson.devDependencies?.prettier !== "3.6.2") throw new Error("Prettier must remain pinned exactly at 3.6.2");
console.log("package.json dependency keys and exact Prettier pin are valid");
