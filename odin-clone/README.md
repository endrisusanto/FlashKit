# Odin By Endri-Pro ⚡

A high-performance, industrial-grade Samsung Firmware Flashing Tool. This project is a modern, high-speed clone of Odin4 built with **Tauri**, **Rust**, and **Vanilla TypeScript**, designed for professional and bulk provisioning.

![License](https://img.shields.io/badge/license-MIT-blue.svg)
![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20Linux%20(deb%2frpm)-orange)

## ✨ Features

- 🚀 **High Performance**: Powered by a Rust backend for maximum flashing stability.
- 📱 **Smart Device Management**: Auto-detection of new devices with persistent history even after disconnection.
- 🎨 **Premium UI/UX**: 
  - Fully responsive layout that stretches to fill your screen.
  - Modern animated circle checkboxes.
  - Interactive device logs via modal view.
  - Ambient "Underglow" effects and smooth transitions.
- 🛡️ **Safe Verification**: Integrated MD5 verification with real-time progress tracking inside the input fields.
- 🐧 **Linux First**: Native support for Fedora (RPM) and Debian/Ubuntu (DEB).
- 🪟 **Windows Support**: Fully compatible with Windows environments.

## 🚀 Installation

You can download the latest binaries from the [Releases](https://github.com/your-username/odin-clone/releases) page.

### Supported Formats:
- **Windows**: `.exe`, `.msi`
- **Linux**: `.rpm` (Fedora, RedHat, openSUSE), `.deb` (Ubuntu, Debian, Mint)

## 🛠️ Local Development

### Prerequisites
- [Node.js](https://nodejs.org/) (LTS)
- [Rust](https://www.rust-lang.org/tools/install)
- Webview2 (for Windows) or `libwebkit2gtk` (for Linux)

### Setup
1. Clone the repository:
   ```bash
   git clone https://github.com/your-username/odin-clone.git
   cd odin-clone
   ```
2. Install dependencies:
   ```bash
   npm install
   ```
3. Run in development mode:
   ```bash
   npm run tauri dev
   ```
4. Build for production:
   ```bash
   npm run tauri build
   ```

## 🤖 Automated Builds (CI/CD)

This repository is equipped with GitHub Actions. To trigger a multi-platform build (Windows, DEB, RPM):
1. Tag your commit: `git tag v0.1.0`
2. Push the tag: `git push origin v0.1.0`
3. GitHub will automatically create a Draft Release with all the binaries.

## 📄 License
This project is licensed under the MIT License.

---
*Developed with ❤️ by Endri-Pro*
