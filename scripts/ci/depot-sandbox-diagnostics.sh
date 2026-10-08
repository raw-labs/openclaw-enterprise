#!/usr/bin/env bash
set -euo pipefail
diagnostics="$RUNNER_TEMP/sandbox-diagnostics"
mkdir -p "$diagnostics"
cat > "$diagnostics/mount.c" <<'SOURCE'
#define _GNU_SOURCE
#include <sched.h>
#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>
#include <sys/mount.h>
#include <sys/wait.h>
#include <fcntl.h>
#include <errno.h>
#include <string.h>
static int gate[2];
static char stack[1024 * 1024];
static void label(void) {
  char buf[8192];
  const char *paths[] = {"/proc/self/attr/current", "/proc/self/status"};
  for (int i = 0; i < 2; i++) {
    int fd = open(paths[i], O_RDONLY);
    ssize_t n = read(fd, buf, sizeof(buf) - 1);
    if (n > 0) { buf[n] = 0; printf("%s: %s\n", paths[i], buf); }
    close(fd);
  }
  fflush(stdout);
}
static int child(void *unused) {
  char c;
  close(gate[1]); read(gate[0], &c, 1); close(gate[0]);
  printf("child uid=%d\n", getuid()); label();
  int result = mount(NULL, "/", NULL, MS_SILENT | MS_SLAVE | MS_REC, NULL);
  printf("mount result=%d errno=%d %s\n", result, errno, strerror(errno));
  fflush(stdout); return result != 0;
}
static void map(pid_t pid, const char *name, const char *value) {
  char path[128]; snprintf(path, sizeof(path), "/proc/%d/%s", pid, name);
  int fd = open(path, O_WRONLY);
  if (fd < 0 || write(fd, value, strlen(value)) < 0) { perror(path); exit(2); }
  close(fd);
}
int main(void) {
  label(); pipe(gate);
  pid_t pid = clone(child, stack + sizeof(stack), CLONE_NEWUSER | CLONE_NEWNS | SIGCHLD, NULL);
  if (pid < 0) { perror("clone"); return 2; }
  map(pid, "setgroups", "deny"); map(pid, "uid_map", "0 1000 1\n"); map(pid, "gid_map", "0 1000 1\n");
  close(gate[0]); write(gate[1], "x", 1); close(gate[1]);
  int status; waitpid(pid, &status, 0); printf("child status=%d\n", status);
  return 0;
}
SOURCE
node_base='docker.io/library/node:24-bookworm@sha256:934240a162082fd8b8a2f90cd5114446443f1eba1c5378f6687167ca405e6584'
docker run --rm --user "$(id -u):$(id -g)" --cap-drop ALL --security-opt no-new-privileges --mount "type=bind,src=$diagnostics,dst=/diagnostics" --entrypoint gcc "$node_base" -O0 -o /diagnostics/mount /diagnostics/mount.c
docker run --rm --mount "type=bind,src=$diagnostics,dst=/diagnostics" --entrypoint sh "$node_base" -c 'apt-get update -qq; cd /diagnostics; apt-get download strace; dpkg-deb -x strace*.deb /diagnostics'
echo "OCE_SANDBOX_TRACE_DIR=$diagnostics" >> "$GITHUB_ENV"
sudo aa-status || true
sudo sysctl kernel.apparmor_restrict_unprivileged_userns kernel.apparmor_restrict_unprivileged_userns_force || true
sudo cat /etc/apparmor.d/unprivileged_userns || true
sudo cat /sys/kernel/security/lsm || true
sudo cat /sys/kernel/security/apparmor/features/mount/mask || true
sudo cat /sys/kernel/security/apparmor/profiles | grep -E 'oce|docker|userns|runc' || true
docker run --rm --read-only --user 1000:1000 --cap-drop ALL --security-opt no-new-privileges --security-opt "seccomp=$OCC_TEST_CODEX_SECCOMP_PROFILE" --security-opt apparmor=oce-ci-codex-sandbox --mount "type=bind,src=$diagnostics,dst=/diagnostics,readonly" --entrypoint /diagnostics/mount "$OCC_TEST_RUNTIME_IMAGE"
