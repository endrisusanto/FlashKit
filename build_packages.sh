#!/bin/bash

echo "Building Bow Device Manager for Linux (DEB and RPM)"

# Ensure we are in the tauri app directory
cd "$(dirname "$0")/bow-rust" || exit

# Install dependencies if not already installed
npm install

# Ensure Rust is available
if [ -f "$HOME/.cargo/env" ]; then
  source "$HOME/.cargo/env"
fi

# Build the Tauri application
# For Linux, this will generate AppImage, .deb, and .rpm if configured correctly.
# The `tauri build` command uses the `--bundles` flag implicitly or explicitly depending on config.
# We specify targets to explicitly build deb and rpm
npm run tauri build -- --bundles deb,rpm

echo "Build complete! Check the src-tauri/target/release/bundle/ directory for your packages."
