# Copyright (c) 2020 Gitpod GmbH. All rights reserved.
# Licensed under the GNU Affero General Public License (AGPL).
# See License.AGPL.txt in the project root for license information.

FROM cgr.dev/chainguard/wolfi-base:latest@sha256:3a1c907d0a8ca6666a9d1f90dabddb654088129d718ce7affb9b906e39a3b7e7

# Ensure latest packages are present, like security updates.
RUN  apk upgrade --no-cache

WORKDIR /installer
COPY components-ws-daemon-seccomp-profile-installer--profile/workspace_default.json .
