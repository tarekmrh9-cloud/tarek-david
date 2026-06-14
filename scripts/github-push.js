"use strict";
const https = require("https");
const fs    = require("fs");
const path  = require("path");

const TOKEN = process.env.GITHUB_TOKEN;
const OWNER = "castrolmocro";
const REPO  = "DAVID-FINAL";
const BRANCH = "main";
const MSG   = process.argv[2] || `🚀 Update: Messenger UI, angel logo, new APIs — ${new Date().toISOString().slice(0,19)}`;

if (!TOKEN) { console.error("❌ GITHUB_TOKEN not set"); process.exit(1); }

function apiReq(method, endpoint, data) {
  return new Promise((resolve, reject) => {
    const body = data ? JSON.stringify(data) : null;
    const opts = {
      hostname: "api.github.com",
      path: `/repos/${OWNER}/${REPO}${endpoint}`,
      method,
      headers: {
        "Authorization": `token ${TOKEN}`,
        "User-Agent": "DAVID-V1-Pusher/1.0",
        "Accept": "application/vnd.github.v3+json",
        "Content-Type": "application/json",
        ...(body ? { "Content-Length": Buffer.byteLength(body) } : {}),
      },
    };
    const req = https.request(opts, res => {
      let raw = "";
      res.on("data", c => raw += c);
      res.on("end", () => {
        try { resolve(JSON.parse(raw)); } catch { resolve(raw); }
      });
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

// Files to push (relative to repo root)
const FILES = [
  "src/dashboard/public/index.html",
  "src/dashboard/server.js",
  "src/dashboard/public/angel.png",
  "src/dashboard/public/angel2.png",
  "scripts/push-to-github.sh",
  "scripts/github-push.js",
  "Procfile",
  "railway.toml",
  "nixpacks.toml",
];

const ROOT = path.join(__dirname, "..");

async function main() {
  console.log(`📤 Pushing to github.com/${OWNER}/${REPO}…`);

  // 1. Get current branch ref
  const refData = await apiReq("GET", `/git/refs/heads/${BRANCH}`);
  const latestSha = refData.object?.sha;
  if (!latestSha) { console.error("❌ Cannot get branch SHA:", JSON.stringify(refData)); process.exit(1); }
  console.log(`  Branch SHA: ${latestSha.slice(0,8)}`);

  // 2. Get base tree SHA
  const commitData = await apiReq("GET", `/git/commits/${latestSha}`);
  const baseTreeSha = commitData.tree?.sha;
  console.log(`  Base tree: ${baseTreeSha?.slice(0,8)}`);

  // 3. Build tree with file contents
  const tree = [];
  for (const relPath of FILES) {
    const fullPath = path.join(ROOT, relPath);
    if (!fs.existsSync(fullPath)) { console.warn(`  ⚠ Skipping missing: ${relPath}`); continue; }
    const isBinary = relPath.endsWith(".png") || relPath.endsWith(".jpg") || relPath.endsWith(".webp");
    if (isBinary) {
      const content = fs.readFileSync(fullPath).toString("base64");
      tree.push({ path: relPath, mode: "100644", type: "blob", content: content, encoding: "base64" });
    } else {
      const content = fs.readFileSync(fullPath, "utf8");
      tree.push({ path: relPath, mode: "100644", type: "blob", content });
    }
    console.log(`  + ${relPath} (${fs.statSync(fullPath).size} bytes)`);
  }

  // 4. Create new tree
  const newTree = await apiReq("POST", "/git/trees", { base_tree: baseTreeSha, tree });
  if (!newTree.sha) { console.error("❌ Failed to create tree:", JSON.stringify(newTree).slice(0,300)); process.exit(1); }
  console.log(`  New tree: ${newTree.sha.slice(0,8)}`);

  // 5. Create commit
  const newCommit = await apiReq("POST", "/git/commits", {
    message: MSG,
    tree: newTree.sha,
    parents: [latestSha],
  });
  if (!newCommit.sha) { console.error("❌ Failed to create commit:", JSON.stringify(newCommit).slice(0,300)); process.exit(1); }
  console.log(`  New commit: ${newCommit.sha.slice(0,8)}`);

  // 6. Update branch ref
  const updated = await apiReq("PATCH", `/git/refs/heads/${BRANCH}`, { sha: newCommit.sha, force: true });
  if (updated.object?.sha) {
    console.log(`✅ Pushed! ${BRANCH} → ${updated.object.sha.slice(0,8)}`);
    console.log(`   https://github.com/${OWNER}/${REPO}/commit/${newCommit.sha}`);
  } else {
    console.error("❌ Failed to update ref:", JSON.stringify(updated).slice(0,300));
  }
}

main().catch(e => { console.error("❌ Fatal:", e.message); process.exit(1); });
