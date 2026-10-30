# Source recipe only: publish and approve an immutable digest before selecting a profile.
ARG NODE_RUNTIME_BASE_IMAGE=docker.io/library/node:24-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20
FROM ${NODE_RUNTIME_BASE_IMAGE}
RUN apt-get update && apt-get upgrade -y \
    && apt-get install -y --no-install-recommends openssh-server openssh-client bash git rsync tar python3 ca-certificates \
    && rm -rf /var/lib/apt/lists/* /etc/ssh/ssh_host_* \
    && usermod --login worker --home /workspace --shell /bin/bash node \
    && groupmod --new-name worker node \
    && passwd -d worker \
    && mkdir -p /run/sshd /workspace \
    && chown 1000:1000 /workspace
COPY --chmod=0555 deploy/runtime/temporary-environments/ssh-entrypoint.mjs /usr/local/bin/occ-temporary-ssh
USER 1000:1000
WORKDIR /workspace
EXPOSE 2222
ENTRYPOINT ["/usr/local/bin/occ-temporary-ssh"]
