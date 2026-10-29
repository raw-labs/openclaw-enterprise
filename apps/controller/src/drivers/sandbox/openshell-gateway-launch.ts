/** The launcher and private exec share only Pod-local files, never retained PVC markers. */
export const GATEWAY_PRIVATE_ROOT = "/tmp/oce-gateway";
export const GATEWAY_LAUNCHER = String.raw`
const fs = require("node:fs");
const cp = require("node:child_process");
const crypto = require("node:crypto");
const root = "/tmp/oce-gateway";
const stateRoot = process.env.HOME + "/.openclaw";
const privateDirectories = ["/home/node/.openclaw/state","/home/node/.openclaw/client","/home/node/.openclaw/agents/main/agent","/home/node/.openclaw/media","/home/node/.openclaw/worktrees","/home/node/.openclaw/worktree-sources","/home/node/.openclaw/agents/main/sessions"];
fs.mkdirSync(stateRoot, {recursive:true,mode:0o700});
const categories = ["state","client","agent","media","worktrees","worktree-sources","sessions"];
for (let index=0; index<privateDirectories.length; index++) {
  const target = "/sandbox/gateway-state/" + categories[index];
  const stat = fs.lstatSync(target);
  if (!stat.isDirectory() || stat.uid !== process.getuid() || (stat.mode & 0o7777) !== 0o700) throw new Error("Gateway private state is not prepared.");
  const path = privateDirectories[index].replace(/^\/home\/node/u,process.env.HOME);
  fs.mkdirSync(require("node:path").dirname(path),{recursive:true,mode:0o700});
  try { if (fs.readlinkSync(path) !== target) throw new Error("Foreign Gateway private path."); }
  catch(error) { if (error.code !== "ENOENT") throw error; fs.symlinkSync(target,path); }
}
const generation = process.env.OCE_GATEWAY_GENERATION;
fs.rmSync(root, {recursive:true, force:true});
fs.mkdirSync(root, {recursive:true, mode:0o700});
const nonce = crypto.randomUUID();
const processRoot = root + "/" + nonce;
fs.mkdirSync(processRoot, {mode:0o700});
fs.writeFileSync(root + "/challenge.json", JSON.stringify({generation, nonce}), {mode:0o600});
const sleep = () => new Promise(r => setTimeout(r, 100));
(async () => {
  let material;
  for (;;) {
    try { material = JSON.parse(fs.readFileSync(processRoot + "/release.json", "utf8")); } catch {}
    if (material?.generation === generation && material.nonce === nonce) break;
    await sleep();
  }
  for (const [name, value] of Object.entries(material.environment)) process.env[name] = value;
  process.env.OPENCLAW_POD_UID = material.instanceId;
  process.env.OPENCLAW_WORKSPACE_NODE_PATH = processRoot + "/workspace-node.json";
  // Native configuration is ephemeral: retained state contains no startup tokens.
  const homeStat = fs.lstatSync(stateRoot);
  if (!homeStat.isDirectory() || homeStat.uid !== process.getuid()) throw new Error("Gateway ephemeral home is not private.");
  const retainedConfig = stateRoot + "/openclaw.json";
  try {
    const stat = fs.lstatSync(retainedConfig);
    if (stat.isSymbolicLink()) fs.unlinkSync(retainedConfig); else fs.rmSync(retainedConfig);
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  fs.symlinkSync(processRoot + "/configuration.json", retainedConfig);
  for (const file of material.files) {
    fs.mkdirSync(require("node:path").dirname(file.path), {recursive:true, mode:0o700});
    fs.writeFileSync(file.path, file.content, {mode:0o600});
  }
  fs.writeFileSync(processRoot + "/configuration.json", JSON.stringify(material.configuration), {mode:0o600});
  process.env.OPENCLAW_CONFIG_PATH = processRoot + "/configuration.json";
  fs.writeFileSync(processRoot + "/accepted.json", JSON.stringify({generation, nonce}), {mode:0o600});
  fs.rmSync(processRoot + "/release.json", {force:true});
  const child = cp.spawn(material.command[0], material.command.slice(1), {stdio:"inherit", env:process.env});
  for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => child.kill(signal));
  child.on("exit", code => process.exit(code ?? 1));
})().catch(() => { process.stderr.write("Gateway private startup failed.\n"); process.exit(1); });
`;

/** Only a non-secret, process-local challenge is returned through authenticated exec. */
export const GATEWAY_CHALLENGE = String.raw`
const fs = require("node:fs");
(async () => {
  let input = "";
  for await (const chunk of process.stdin) { input += chunk; if (Buffer.byteLength(input) > 256) throw new Error(); }
  const challenge = JSON.parse(fs.readFileSync("/tmp/oce-gateway/challenge.json", "utf8"));
  if (challenge.generation !== JSON.parse(input).generation || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/u.test(challenge.nonce)) throw new Error();
  process.stdout.write(challenge.nonce);
})().catch(() => process.exit(1));
`;

/** stdin carries material, while argv and provider configuration remain non-secret. */
export const GATEWAY_RELEASE = String.raw`
const fs = require("node:fs");
(async () => {
  let input = "";
  for await (const chunk of process.stdin) { input += chunk; if (Buffer.byteLength(input) > 380000) throw new Error(); }
  const material = JSON.parse(input);
  const root = "/tmp/oce-gateway";
  const challenge = JSON.parse(fs.readFileSync(root + "/challenge.json", "utf8"));
  if (challenge.generation !== material.generation || challenge.nonce !== material.nonce || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/u.test(material.nonce)) throw new Error();
  // Never create this directory: only the held launcher owns it. A restart removes it.
  const processRoot = root + "/" + material.nonce;
  try {
    const accepted = JSON.parse(fs.readFileSync(processRoot + "/accepted.json", "utf8"));
    if (accepted.generation === challenge.generation && accepted.nonce === challenge.nonce) return;
  } catch {}
  fs.writeFileSync(processRoot + "/release.staged", JSON.stringify(material), {mode:0o600});
  fs.renameSync(processRoot + "/release.staged", processRoot + "/release.json");
})().catch(() => process.exit(1));
`;

export const GATEWAY_BINDING_UPDATE = String.raw`
const fs = require("node:fs");
(async () => {
  let input = "";
  for await (const chunk of process.stdin) { input += chunk; if (Buffer.byteLength(input) > 4096) throw new Error(); }
  const binding = JSON.parse(input);
  const root = "/tmp/oce-gateway";
  const challenge = JSON.parse(fs.readFileSync(root + "/challenge.json", "utf8"));
  if (challenge.generation !== binding.generation || challenge.nonce !== binding.nonce || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/u.test(binding.nonce)) throw new Error();
  const processRoot = root + "/" + binding.nonce;
  fs.writeFileSync(processRoot + "/workspace-node.staged", JSON.stringify({revisionId:binding.revisionId, deviceId:binding.nodeId}), {mode:0o600});
  fs.renameSync(processRoot + "/workspace-node.staged", processRoot + "/workspace-node.json");
})().catch(() => process.exit(1));
`;
