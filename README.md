# FlashKit ⚡

Modern Android Device Provisioning Tool built with Rust (Tauri) and React. Designed for speed, reliability, and ease of use with a native Windows 11 Fluent Design aesthetic.

![FlashKit](https://img.shields.io/badge/Platform-Linux%20%7C%20Windows-blue?style=for-the-badge&logo=android)
![Rust](https://img.shields.io/badge/Rust-000000?style=for-the-badge&logo=rust&logoColor=white)
![React](https://img.shields.io/badge/React-20232A?style=for-the-badge&logo=react&logoColor=61DAFB)

## Features 🚀

- **Skip Setup Wizard**: One-click bypass for Android/Samsung Setup Wizards (FRP-style provisioning).
- **Auto WiFi Connect**: Automatically provision WiFi credentials to multiple devices simultaneously.
- **Fluent Design**: Native-feeling Windows 11 Dark Mode interface.
- **ADB Integration**: Automatic detection and management of connected devices.
- **Cross-Platform**: Built for Linux (RPM/DEB) and Windows (EXE).

## Quick Start 🛠️

### Prerequisites
- Android device with USB Debugging enabled (or enabled via test menu exploit).
- ADB installed on your system.

### Installation (Linux)
```bash
# For Fedora/RHEL
sudo dnf install ./FlashKit-1.0.0-1.x86_64.rpm

# For Ubuntu/Debian
sudo dpkg -i FlashKit_1.0.0_amd64.deb
```

### Installation (Windows)
Download the latest `FlashKit.exe` from the [GitHub Releases](https://github.com/yourusername/FlashKit/releases). Place `adb.exe`, `AdbWinApi.dll`, and `AdbWinUsbApi.dll` in the same folder for portable use.

## Development 💻

### Build from source

1. **Install Dependencies**:
   - [Node.js](https://nodejs.org/)
   - [Rust](https://rustup.rs/)

2. **Clone and Install**:
   ```bash
   git clone https://github.com/yourusername/FlashKit.git
   cd FlashKit/bow-rust
   npm install
   ```

3. **Run in Dev Mode**:
   ```bash
   npm run tauri dev
   ```

4. **Build Production**:
   ```bash
   npm run tauri build
   ```

## Workflow 🏗️

The project includes a GitHub Action (`build-windows.yml`) that automatically builds the Windows `.exe` and Linux packages on every push or manual trigger.

## License 📄
Private/Proprietary for internal provisioning use.

---
*Maintained by endri-pro*
