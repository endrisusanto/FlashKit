#!/bin/bash


# Ensure we are in the tauri app directory
cd "$(dirname "$0")/bow-rust" || exit

# Install dependencies if not already installed
npm install

# Ensure Rust is available
if [ -f "$HOME/.cargo/env" ]; then
  source "$HOME/.cargo/env"
fi

# Detect OS and set appropriate bundles
OS_TYPE="$(uname -s)"
if [[ "$OS_TYPE" == "Linux" ]]; then
  echo "Detected Linux - Building DEB, RPM, and AppImage"
  BUNDLES="deb,rpm,appimage"
elif [[ "$OS_TYPE" == *"MINGW"* ]] || [[ "$OS_TYPE" == *"MSYS"* ]] || [[ "$OS_TYPE" == *"CYGWIN"* ]]; then
  echo "Detected Windows - Building EXE (NSIS)"
  BUNDLES="nsis"
else
  echo "Detected Other OS - Attempting all bundles"
  BUNDLES="all"
fi

# Build the Tauri application
npm run tauri build -- --bundles "$BUNDLES"

echo "Build complete! Check the src-tauri/target/release/bundle/ directory for your packages."
