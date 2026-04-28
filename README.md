# FlashKit ⚡

Modern Android Device Provisioning Tool built with Rust (Tauri) and React. Designed for speed, reliability, and ease of use with a native Windows 11 Fluent Design aesthetic.

![FlashKit](https://img.shields.io/badge/Platform-Windows-blue?style=for-the-badge&logo=windows)
![Rust](https://img.shields.io/badge/Rust-000000?style=for-the-badge&logo=rust&logoColor=white)
![React](https://img.shields.io/badge/React-20232A?style=for-the-badge&logo=react&logoColor=61DAFB)

## Features 🚀

- **Skip Setup Wizard**: One-click bypass for Android/Samsung Setup Wizards (FRP-style provisioning).
- **Auto WiFi Connect**: Automatically provision WiFi credentials to multiple devices simultaneously.
- **Fluent Design**: Native Windows 11 Dark Mode interface.
- **ADB Integration**: Automatic detection and management of connected devices.
- **Portable**: Run directly without installation (standalone EXE).

## Quick Start 🛠️

### Prerequisites
- Android device with USB Debugging enabled.
- ADB drivers installed on your PC.

### Installation & Usage
1.  Download the latest **`FlashKit-Setup.exe`** from the [GitHub Releases](https://github.com/endrisusanto/FlashKit/releases).
2.  Install and launch the application.
3.  Connect your devices and start provisioning!

## Portable Use 🧳
For a completely portable experience:
1. Download the portable zip from releases.
2. Ensure `adb.exe` and `WifiUtil.apk` are in the same directory as `FlashKit.exe`.

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
