#!/bin/bash

echo "Building FlashKit for Linux (DEB, RPM, AppImage) and Windows (EXE)"

# Ensure we are in the tauri app directory
cd "$(dirname "$0")/bow-rust" || exit

# Install dependencies if not already installed
npm install

# Ensure Rust is available
if [ -f "$HOME/.cargo/env" ]; then
  source "$HOME/.cargo/env"
fi

# Build the Tauri application
# nsis produces .exe for Windows.
# deb, rpm, appimage for Linux.
npm run tauri build -- --bundles deb,rpm,appimage,nsis

echo "Build complete! Check the src-tauri/target/release/bundle/ directory for your packages."
