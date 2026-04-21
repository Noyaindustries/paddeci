import fs from "fs";
import path from "path";

const root = process.cwd();
const srcDir = path.join(root, "PADDE CI");
const destDir = path.join(root, "dist");

const skip = new Set([
  "netlify",
  "node_modules",
  "package.json",
  "package-lock.json",
  "netlify.toml",
]);

if (!fs.existsSync(srcDir)) {
  console.error("Dossier source introuvable:", srcDir);
  process.exit(1);
}

fs.mkdirSync(destDir, { recursive: true });

for (const name of fs.readdirSync(srcDir)) {
  if (skip.has(name)) continue;
  const from = path.join(srcDir, name);
  const to = path.join(destDir, name);
  const st = fs.statSync(from);
  if (st.isDirectory()) continue;
  fs.copyFileSync(from, to);
}

console.log("Fichiers statiques copiés vers dist/");
