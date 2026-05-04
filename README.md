# FlashKit ⚡

Modern, All-in-One Android Device Flashing & Provisioning Tool built with Rust (Tauri) and React. Designed for speed, reliability, and ease of use with a stunning, premium **Industrial Dark Aesthetic**.

![FlashKit](https://img.shields.io/badge/Platform-Windows%20%7C%20Linux-blue?style=for-the-badge&logo=linux)
![Rust](https://img.shields.io/badge/Rust-000000?style=for-the-badge&logo=rust&logoColor=white)
![React](https://img.shields.io/badge/React-20232A?style=for-the-badge&logo=react&logoColor=61DAFB)

## Features 🚀

- **Master Sequence Automation**: Fully automated flow from Firmware Flashing to Device Provisioning.
- **Odin Firmware Flasher**: Built-in support for flashing Samsung firmware (`odin4` backend) with slot selection (BL, AP, CP, CSC, USERDATA).
- **AT Exploit Integration**: Automatically detects Samsung Modems and sends AT commands to wake up ADB/USB Debugging on locked devices.
- **Skip Setup Wizard**: One-click bypass for Android/Samsung Setup Wizards (SUW).
- **Auto WiFi Connect**: Automatically provision WiFi credentials to multiple devices simultaneously.
- **Industrial Design**: Premium, highly polished dark mode interface with interactive hover states, micro-animations, and dynamic feedback.
- **Multi-Platform**: Native support and packaging for Windows (`.exe`) and Linux (`.deb`, `.rpm`).

## Quick Start 🛠️

### Prerequisites
- **Windows**: Standard Samsung USB Drivers.
- **Linux**: Udev rules for Samsung devices (`04e8`) must be configured to allow ADB and Odin access without root.
- `odin4` binary must be accessible in your system or bundled correctly.

### Installation
1. Download the latest release from the [GitHub Releases](https://github.com/endrisusanto/FlashKit/releases).
   - **Windows**: Download the `.exe` setup file.
   - **Linux**: Download and install the `.deb` or `.rpm` package (e.g., `sudo dnf install ./FlashKit-1.0.0-1.x86_64.rpm`).
2. Install and launch the application.
3. Connect your devices and start provisioning!

## Development 💻

### Build from source

1. **Install Dependencies**:
   - [Node.js](https://nodejs.org/)
   - [Rust](https://rustup.rs/)

2. **Clone the Repository**:
   ```bash
   git clone https://github.com/endrisusanto/FlashKit.git
   cd FlashKit/bow-rust
   npm install
   ```

3. **Run in Dev Mode**:
   ```bash
   npm run tauri dev
   ```

4. **Build Production**:
   - For Windows (`.exe` / `nsis`):
     ```bash
     npm run tauri build
     ```
   - For Linux (`.deb`, `.rpm`):
     ```bash
     npm run tauri build --bundles deb,rpm
     ```
     *(A convenience script `build_packages.sh` is also provided in the root directory)*

## Workflow 🏗️

The project includes GitHub Actions (`release.yml`) that can automatically build the Windows/Linux installers when you push a new `v*` tag to the repository.

```bash
git tag v1.5.0
git push origin v1.5.0
```

## License 📄
Private/Proprietary for internal provisioning use.

---
*Created and Maintained by **Endri-Pro***
