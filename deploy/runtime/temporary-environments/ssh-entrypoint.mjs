#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";

// This is the container's PID 1. Exiting also terminates every SSH descendant in
// its PID namespace, including commands that outlive their original connection.
process.umask(0o077);
const publicKey = process.env.OCC_SSH_AUTHORIZED_KEY ?? "";
const expiresAt = Date.parse(process.env.OCC_HARD_EXPIRES_AT ?? "");
const idle = Number(process.env.OCC_IDLE_TIMEOUT_SECONDS);
const remaining = expiresAt - Date.now();
if (
  process.pid !== 1 ||
  process.getuid() !== 1000 ||
  process.getgid() !== 1000 ||
  !/^ssh-ed25519 [A-Za-z0-9+/]{68}=?$/.test(publicKey) ||
  !Number.isSafeInteger(idle) ||
  idle < 1 ||
  idle > 86400 ||
  !Number.isFinite(remaining) ||
  remaining <= 0 ||
  remaining > 86400000
) {
  throw new Error("Invalid temporary SSH identity or expiry policy");
}
const key = Buffer.from(publicKey.slice(12), "base64");
if (
  key.length !== 51 ||
  key.readUInt32BE(0) !== 11 ||
  key.subarray(4, 15).toString() !== "ssh-ed25519" ||
  key.readUInt32BE(15) !== 32
) {
  throw new Error("Invalid Ed25519 authorized key");
}
const directory = mkdtempSync("/tmp/occ-ssh-");
writeFileSync(directory + "/authorized_keys", "restrict " + publicKey + "\n", { mode: 0o600 });
const generated = spawnSync(
  "/usr/bin/ssh-keygen",
  ["-q", "-t", "ed25519", "-N", "", "-f", directory + "/host_key"],
  { stdio: "ignore" },
);
if (generated.status !== 0) {
  throw new Error("Cannot generate ephemeral SSH host key");
}
writeFileSync(
  directory + "/sshd_config",
  [
    "Port 2222",
    "ListenAddress 0.0.0.0",
    "AddressFamily inet",
    "HostKey " + directory + "/host_key",
    "PidFile " + directory + "/sshd.pid",
    "AuthorizedKeysFile " + directory + "/authorized_keys",
    "AllowUsers worker",
    "AuthenticationMethods publickey",
    "PubkeyAuthentication yes",
    "PasswordAuthentication no",
    "PermitEmptyPasswords no",
    "KbdInteractiveAuthentication no",
    "UsePAM no",
    "PermitRootLogin no",
    "DisableForwarding yes",
    "AllowTcpForwarding no",
    "AllowAgentForwarding no",
    "X11Forwarding no",
    "PermitTunnel no",
    "PermitTTY no",
    "PermitUserEnvironment no",
    "PermitUserRC no",
    "StrictModes yes",
    "LoginGraceTime 20",
    "MaxAuthTries 3",
    "MaxSessions 4",
    "ClientAliveInterval " + Math.min(idle, 30),
    "ClientAliveCountMax 1",
    "Subsystem sftp internal-sftp",
    "LogLevel ERROR",
    "",
  ].join("\n"),
  { mode: 0o600 },
);
const server = spawn("/usr/sbin/sshd", ["-D", "-e", "-f", directory + "/sshd_config"], {
  stdio: "inherit",
  env: { PATH: "/usr/local/bin:/usr/bin:/bin", HOME: "/workspace" },
});
server.on("error", () => process.exit(1));
server.on("exit", (code) => process.exit(code ?? 1));
for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => process.exit(0));
}
// Use an absolute-clock check as well as a monotonic timer: clock corrections
// cannot extend the accepted lifetime. Controller and Pod deadlines are independent.
setTimeout(() => process.exit(0), remaining);
setInterval(() => {
  if (Date.now() >= expiresAt) {
    process.exit(0);
  }
}, 250);
