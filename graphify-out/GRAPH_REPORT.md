# Graph Report - /home/endri-pro/dev/BOW  (2026-08-02)

## Corpus Check
- 87 files · ~225,876 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 288 nodes · 456 edges · 28 communities (22 shown, 6 thin omitted)
- Extraction: 97% EXTRACTED · 3% INFERRED · 0% AMBIGUOUS · INFERRED: 14 edges (avg confidence: 0.87)
- Token cost: 0 input · 0 output

## Community Hubs (Navigation)
- Rust Backend & ADB Core
- Tauri App Configuration
- IPC & Progress Broadcasting
- React Frontend Dependencies
- Build Toolchain & Dev Config
- TypeScript Compiler Config
- Version Bump & Release Scripts
- React UI Components & App State
- GBA Automation Analysis & ROI
- Device Cache & Busy State
- App Icons & Visual Assets
- Tauri Capabilities & Permissions
- TypeScript Node Config
- Build Package Scripts
- Release Scripts
- Rust Cargo Dependencies
- Odin Flash Engine
- Device Discovery & USB
- GitHub CI/CD Workflows
- Workspace & Package Metadata

## God Nodes (most connected - your core abstractions)
1. `compilerOptions` - 16 edges
2. `run_blocking()` - 15 edges
3. `odin_flash_device_blocking()` - 12 edges
4. `odin_check_file_blocking()` - 11 edges
5. `read_busy_state()` - 9 edges
6. `FlashKit Tool` - 8 edges
7. `broadcast_to_clients()` - 7 edges
8. `odin_list_devices()` - 7 edges
9. `odin_list_devices_blocking()` - 7 edges
10. `resolve_usb_paths()` - 7 edges

## Surprising Connections (you probably didn't know these)
- `To-Be FlashKit Automated Workflow` --semantically_similar_to--> `Master Sequence Automation`  [INFERRED] [semantically similar]
  docs/analisis_inovasi_odin_gba.md → README.md
- `WifiUtil.apk - ADB WiFi Provisioning Tool` --semantically_similar_to--> `Auto WiFi Connect`  [INFERRED] [semantically similar]
  docs/analisis_inovasi_odin_gba.md → README.md
- `Odin Engine Firmware Flashing Dashboard UI Mockup` --semantically_similar_to--> `FlashKit v1.6.2 Web Dashboard - Device Fleet Overview`  [INFERRED] [semantically similar]
  flashkit_odin_mockup.png → flashkit_v162_landing_mockup.png
- `Firmware Slot Selection (BL/AP/CP/CSC/USERDATA)` --conceptually_related_to--> `FlashKit Desktop App Icon Set (Windows/Linux)`  [AMBIGUOUS]
  flashkit_odin_mockup.png → bow-rust/src-tauri/icons/128x128.png
- `Inovasi Odin GBA Analysis Document` --conceptually_related_to--> `FlashKit Tool`  [INFERRED]
  docs/analisis_inovasi_odin_gba.md → README.md

## Import Cycles
- None detected.

## Hyperedges (group relationships)
- **FlashKit Core Automation Feature Set** — readme_master_sequence_automation, readme_odin_firmware_flasher, readme_at_exploit_integration, readme_skip_setup_wizard, readme_auto_wifi_connect [EXTRACTED 1.00]
- **FlashKit Cross-Platform Icon Asset Family** — bow_rust_app_icon_flashkit_icon, bow_rust_src_tauri_icons_desktop_icon_set, bow_rust_src_tauri_icons_android_icon_set, bow_rust_src_tauri_icons_store_logo [INFERRED 0.95]
- **FlashKit UI Design System - Industrial Dark Theme** — flashkit_odin_mockup_ui, flashkit_v162_landing_mockup_dashboard, flashkit_v162_landing_emergency_stop, flashkit_odin_mockup_multi_device_table [INFERRED 0.85]

## Communities (28 total, 6 thin omitted)

### Community 0 - "Rust Backend & ADB Core"
Cohesion: 0.18
Nodes (38): adb_props_blocking(), AdbDeviceExt, emergency_stop(), emergency_stop_blocking(), find_adb(), get_adb_devices_advanced(), get_adb_devices_advanced_blocking(), get_busy_devices() (+30 more)

### Community 1 - "Tauri App Configuration"
Cohesion: 0.07
Nodes (27): app, security, windows, withGlobalTauri, build, beforeBuildCommand, beforeDevCommand, devUrl (+19 more)

### Community 2 - "IPC & Progress Broadcasting"
Cohesion: 0.12
Nodes (26): AppHandle, Arc, broadcast_progress(), broadcast_to_clients(), drain_pipe(), emit_progress_locally(), extract_percentage(), FlashParams (+18 more)

### Community 3 - "React Frontend Dependencies"
Cohesion: 0.08
Nodes (25): dependencies, canvas-confetti, lucide-react, react, react-dom, @tauri-apps/api, @tauri-apps/plugin-dialog, @tauri-apps/plugin-opener (+17 more)

### Community 4 - "Build Toolchain & Dev Config"
Cohesion: 0.09
Nodes (23): autoprefixer, devDependencies, autoprefixer, postcss, tailwindcss, @tailwindcss/postcss, @tauri-apps/cli, @types/canvas-confetti (+15 more)

### Community 5 - "TypeScript Compiler Config"
Cohesion: 0.09
Nodes (22): compilerOptions, allowImportingTsExtensions, isolatedModules, jsx, lib, module, moduleResolution, noEmit (+14 more)

### Community 6 - "Version Bump & Release Scripts"
Cohesion: 0.12
Nodes (13): cargoLockPath, cargoTomlPath, nextVersion(), packageJson, packageJsonPath, packageLock, packageLockPath, parseVersion() (+5 more)

### Community 7 - "React UI Components & App State"
Cohesion: 0.15
Nodes (13): App(), CachedDevice, DeviceCache, playSuccessSound(), SamsungPortInfo, startConfettiLoop(), DeviceData, FilePaths (+5 more)

### Community 8 - "GBA Automation Analysis & ROI"
Cohesion: 0.14
Nodes (17): As-Is Manual Provisioning Workflow, Inovasi Odin GBA Analysis Document, GBA Testing 96% Time Saving ROI, To-Be FlashKit Automated Workflow, WifiUtil.apk - ADB WiFi Provisioning Tool, Build Windows x64 GitHub Action, Version Bump Script (bump-version.mjs), Multi-Platform Build Matrix (Windows + Ubuntu) (+9 more)

### Community 9 - "Device Cache & Busy State"
Cohesion: 0.27
Nodes (13): BusyState, CachedAdbDevice, clear_busy(), DeviceCache, get_device_cache(), mark_busy(), now_ms(), read_busy_state() (+5 more)

### Community 10 - "App Icons & Visual Assets"
Cohesion: 0.17
Nodes (12): FlashKit Application Icon (app-icon), FlashKit Android App Icon Set (mipmap variants), FlashKit Desktop App Icon Set (Windows/Linux), FlashKit Windows Store Logo, Odin GBA Innovation Workflow Diagram, Firmware Slot Selection (BL/AP/CP/CSC/USERDATA), Multi-Device Connected Devices Table (SM-G998B, S21 Ultra), Odin Engine Firmware Flashing Dashboard UI Mockup (+4 more)

### Community 11 - "Tauri Capabilities & Permissions"
Cohesion: 0.20
Nodes (9): description, identifier, permissions, $schema, windows, core:default, dialog:default, main (+1 more)

### Community 12 - "TypeScript Node Config"
Cohesion: 0.22
Nodes (8): compilerOptions, allowSyntheticDefaultImports, composite, module, moduleResolution, skipLibCheck, include, vite.config.ts

### Community 13 - "Build Package Scripts"
Cohesion: 0.60
Nodes (3): install_linux_package(), install_windows_package(), build_packages.sh script

## Ambiguous Edges - Review These
- `FlashKit Desktop App Icon Set (Windows/Linux)` → `Firmware Slot Selection (BL/AP/CP/CSC/USERDATA)`  [AMBIGUOUS]
  flashkit_odin_mockup.png · relation: conceptually_related_to

## Knowledge Gaps
- **117 isolated node(s):** `name`, `private`, `version`, `type`, `dev` (+112 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **6 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **What is the exact relationship between `FlashKit Desktop App Icon Set (Windows/Linux)` and `Firmware Slot Selection (BL/AP/CP/CSC/USERDATA)`?**
  _Edge tagged AMBIGUOUS (relation: conceptually_related_to) - confidence is low._
- **Why does `devDependencies` connect `Build Toolchain & Dev Config` to `React Frontend Dependencies`?**
  _High betweenness centrality (0.019) - this node is a cross-community bridge._
- **What connects `name`, `private`, `version` to the rest of the system?**
  _117 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Tauri App Configuration` be split into smaller, more focused modules?**
  _Cohesion score 0.07142857142857142 - nodes in this community are weakly interconnected._
- **Should `IPC & Progress Broadcasting` be split into smaller, more focused modules?**
  _Cohesion score 0.1225071225071225 - nodes in this community are weakly interconnected._
- **Should `React Frontend Dependencies` be split into smaller, more focused modules?**
  _Cohesion score 0.07692307692307693 - nodes in this community are weakly interconnected._
- **Should `Build Toolchain & Dev Config` be split into smaller, more focused modules?**
  _Cohesion score 0.08695652173913043 - nodes in this community are weakly interconnected._