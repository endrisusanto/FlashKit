# FlashKit v1.6.6 - Industrial Bulk Provisioning Tool

FlashKit is a high-performance, industrial-grade tool designed for bulk Android device provisioning and firmware flashing. Built with **Tauri**, **Rust**, and **React**, it provides a robust and efficient workflow for managing large quantities of Samsung devices simultaneously.

## 🚀 Key Features

### 1. Advanced Device Tracking
- **Physical USB Path Mapping**: Devices are identified by their physical USB port location (`USB:1-3`, etc.), ensuring identity consistency across reboots and mode changes (ADB to Odin).
- **Persistent Port History**: Remembers device serials and models per port even after disconnects.

### 2. Unified Industrial Workflow (Master Sequence)
- **One-Click Automation**: Orchestrates the entire process from Odin Flashing to Skip Setup Wizard (SUW), GBA Setup, and WiFi configuration.
- **Cross-Tab Synchronization**: Real-time progress visualization and selection state sharing between ADB and Odin tabs.
- **Visual Progress Overlay**: See flashing progress directly on device cards in the main dashboard.

### 3. Industrial-Grade Reliability
- **10x10 Retry Mechanism**: Robust post-reboot ADB detection with 10 attempts and 10-second intervals to handle slow boot-up times.
- **Emergency Stop**: Instantly kill all running `odin4` and `adb` processes with a high-visibility glowing emergency button.
- **Conflict Management**: Cross-instance lock system (`busy` flags) prevents multiple windows from accessing the same device.
- **Admin Utilities**: "Reset Busy" feature to recover from stuck states after application crashes.

### 4. Technical Specifications
- **Backend**: Rust (Tauri Core) for high-speed process management and system-level USB path resolution.
- **Frontend**: React + TypeScript with a premium, sharp industrial aesthetic.
- **Binary Support**: Native support for `odin4` CLI and `adb` binaries included in the distribution.

## 🛠 Installation

### Linux (Debian/RPM)
```bash
./build_packages.sh
# Install via dpkg or rpm
sudo dpkg -i src-tauri/target/release/bundle/deb/FlashKit_1.6.6_amd64.deb
```

### Windows
- Ensure `odin4.exe` and `adb.exe` are available in the system path or local `bin/` directory.

## ⚙️ Development

```bash
npm install
npm run tauri dev
```

## 📜 License
© 2024 Endri-Pro. All rights reserved. Industrial Bulk Flashing Solution.
