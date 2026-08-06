#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Ensure we are in the tauri app directory
cd "$SCRIPT_DIR/bow-rust" || exit 1

# Install dependencies if not already installed
npm install

# Ensure Rust is available
if [ -f "$HOME/.cargo/env" ]; then
  source "$HOME/.cargo/env"
fi

# Detect OS and set appropriate bundles
OS_TYPE="$(uname -s)"
LINUX_FAMILY=""
if [[ "$OS_TYPE" == "Linux" ]]; then
  if [[ -f /etc/os-release ]]; then
    . /etc/os-release
    OS_ID="${ID:-}"
    OS_ID_LIKE="${ID_LIKE:-}"
    if [[ "$OS_ID" == "fedora" || "$OS_ID" == "rhel" || "$OS_ID" == "centos" || "$OS_ID" == "rocky" || "$OS_ID" == "almalinux" || "$OS_ID_LIKE" == *"fedora"* || "$OS_ID_LIKE" == *"rhel"* ]]; then
      LINUX_FAMILY="rpm"
    elif [[ "$OS_ID" == "debian" || "$OS_ID" == "ubuntu" || "$OS_ID" == "linuxmint" || "$OS_ID" == "pop" || "$OS_ID_LIKE" == *"debian"* || "$OS_ID_LIKE" == *"ubuntu"* ]]; then
      LINUX_FAMILY="deb"
    fi
  fi

  # Fallback to command detection if OS family still unknown
  if [[ -z "$LINUX_FAMILY" ]]; then
    if command -v dnf >/dev/null 2>&1 || command -v rpm >/dev/null 2>&1; then
      LINUX_FAMILY="rpm"
    elif command -v apt >/dev/null 2>&1 || command -v dpkg >/dev/null 2>&1; then
      LINUX_FAMILY="deb"
    fi
  fi

  if [[ "$LINUX_FAMILY" == "rpm" ]]; then
    echo "Detected Fedora/RHEL Linux - Building RPM"
    BUNDLES="rpm"
  elif [[ "$LINUX_FAMILY" == "deb" ]]; then
    echo "Detected Debian/Ubuntu Linux - Building DEB"
    BUNDLES="deb"

    # ponytail: install tauri system dependencies if missing on new ubuntu/debian
    DEPS=(build-essential pkg-config libudev-dev libglib2.0-dev libgtk-3-dev libwebkit2gtk-4.1-dev libssl-dev)
    MISSING=()
    for dep in "${DEPS[@]}"; do
      dpkg -s "$dep" &>/dev/null || MISSING+=("$dep")
    done
    if [ ${#MISSING[@]} -ne 0 ]; then
      echo "Missing system dependencies: ${MISSING[*]}"
      sudo apt-get update && sudo apt-get install -y "${MISSING[@]}"
    fi
  else
    echo "Detected Linux - Unknown distro family, building DEB and RPM"
    BUNDLES="deb,rpm"
  fi
elif [[ "$OS_TYPE" == *"MINGW"* ]] || [[ "$OS_TYPE" == *"MSYS"* ]] || [[ "$OS_TYPE" == *"CYGWIN"* ]]; then
  echo "Detected Windows - Building EXE (NSIS)"
  BUNDLES="nsis"
else
  echo "Detected Other OS - Attempting all bundles"
  BUNDLES="all"
fi

# Build the Tauri application
npm run tauri build -- --bundles "$BUNDLES"

BUNDLE_DIR="$PWD/src-tauri/target/release/bundle"

latest_file() {
  [[ -d "$1" ]] || return 0
  find "$1" -maxdepth 1 -type f -name "$2" -printf '%T@ %p\n' 2>/dev/null \
    | sort -nr \
    | head -n 1 \
    | cut -d' ' -f2-
}

install_linux_package() {
  local deb_file rpm_file
  deb_file="$(latest_file "$BUNDLE_DIR/deb" "*.deb")"
  rpm_file="$(latest_file "$BUNDLE_DIR/rpm" "*.rpm")"

  echo "Uninstalling existing FlashKit app..."
  if command -v apt >/dev/null 2>&1; then
    sudo apt purge -y flash-kit 2>/dev/null || true
  elif command -v dpkg >/dev/null 2>&1; then
    sudo dpkg -P flash-kit 2>/dev/null || true
  fi
  if command -v dnf >/dev/null 2>&1; then
    sudo dnf remove -y flash-kit 2>/dev/null || true
  elif command -v rpm >/dev/null 2>&1; then
    sudo rpm -e flash-kit 2>/dev/null || true
  fi

  # Clear active state files during package updates
  echo "Clearing state files and caches..."
  rm -f /tmp/flashkit_busy.json /tmp/flashkit_ui_state.json 2>/dev/null || true
  rm -f "C:\\Windows\\Temp\\flashkit_busy.json" "C:\\Windows\\Temp\\flashkit_ui_state.json" 2>/dev/null || true

  if [[ "$LINUX_FAMILY" == "deb" && -n "$deb_file" ]] && command -v apt >/dev/null 2>&1; then
    echo "Installing fresh DEB package: $deb_file"
    sudo apt install -y "$deb_file"
    return
  fi

  if [[ "$LINUX_FAMILY" == "deb" && -n "$deb_file" ]] && command -v dpkg >/dev/null 2>&1; then
    echo "Installing fresh DEB package: $deb_file"
    sudo dpkg -i "$deb_file" || sudo apt-get install -f -y
    return
  fi

  if [[ "$LINUX_FAMILY" == "rpm" && -n "$rpm_file" ]] && command -v dnf >/dev/null 2>&1; then
    echo "Installing fresh RPM package: $rpm_file"
    sudo dnf install -y "$rpm_file"
    return
  fi

  if [[ "$LINUX_FAMILY" == "rpm" && -n "$rpm_file" ]] && command -v yum >/dev/null 2>&1; then
    echo "Installing fresh RPM package: $rpm_file"
    sudo yum install -y "$rpm_file"
    return
  fi

  if [[ "$LINUX_FAMILY" == "rpm" && -n "$rpm_file" ]] && command -v zypper >/dev/null 2>&1; then
    echo "Installing fresh RPM package: $rpm_file"
    sudo zypper --non-interactive install "$rpm_file"
    return
  fi

  if [[ "$LINUX_FAMILY" == "rpm" && -n "$rpm_file" ]] && command -v rpm >/dev/null 2>&1; then
    echo "Installing fresh RPM package: $rpm_file"
    sudo rpm -ivh "$rpm_file"
    return
  fi

  if [[ -z "$LINUX_FAMILY" ]]; then
    if [[ -n "$deb_file" ]] && command -v apt >/dev/null 2>&1; then
      echo "Installing fresh DEB package: $deb_file"
      sudo apt install -y "$deb_file"
      return
    fi

    if [[ -n "$rpm_file" ]] && command -v dnf >/dev/null 2>&1; then
      echo "Installing fresh RPM package: $rpm_file"
      sudo dnf install -y "$rpm_file"
      return
    fi
  fi

  echo "Build complete, but no supported Linux installer command was found."
  echo "Packages are in: $BUNDLE_DIR"
}

install_windows_package() {
  local nsis_file
  nsis_file="$(latest_file "$BUNDLE_DIR/nsis" "*.exe")"

  if [[ -z "$nsis_file" ]]; then
    echo "Build complete, but no NSIS installer was found in: $BUNDLE_DIR/nsis"
    return
  fi

  echo "Launching Windows installer: $nsis_file"
  "$nsis_file"
}

echo "Build complete. Installing latest package..."

if [[ "$OS_TYPE" == "Linux" ]]; then
  install_linux_package
elif [[ "$OS_TYPE" == *"MINGW"* ]] || [[ "$OS_TYPE" == *"MSYS"* ]] || [[ "$OS_TYPE" == *"CYGWIN"* ]]; then
  install_windows_package
else
  echo "Auto install is not configured for $OS_TYPE."
  echo "Packages are in: $BUNDLE_DIR"
fi
