# Headless test runner: the same setup as CI (Linux + xvfb), so VS Code windows
# never appear on the desktop. Built and run by scripts/docker/testInDocker.mjs.
FROM node:24

# git for the fixtures, xvfb as the invisible display, the rest is what VS Code's
# Electron needs on Linux.
RUN apt-get update && apt-get install -y --no-install-recommends \
      git xvfb xauth rsync \
      libgtk-3-0 libnss3 libxss1 libasound2 libgbm1 libxkbfile1 libsecret-1-0 \
      libx11-xcb1 libxcomposite1 libxdamage1 libxrandr2 libdrm2 libatk-bridge2.0-0 libcups2 \
    && rm -rf /var/lib/apt/lists/*

# Fixture commits that don't set their own identity, e.g. a test committing in a submodule.
RUN git config --global user.name "UI Tests" && git config --global user.email "ui-tests@example.com"

WORKDIR /work
