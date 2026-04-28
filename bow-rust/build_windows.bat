@echo off
echo ============================================
echo   BOW DEVICE MANAGER - Windows Build Script
echo ============================================
echo.

:: Check for Node.js
where node >nul 2>&1
if %errorlevel% neq 0 (
    echo [ERROR] Node.js not found! Install from https://nodejs.org
    pause
    exit /b 1
)

:: Check for Rust/Cargo
where cargo >nul 2>&1
if %errorlevel% neq 0 (
    echo [ERROR] Rust not found! Install from https://rustup.rs
    pause
    exit /b 1
)

echo [1/3] Installing npm dependencies...
call npm install

echo [2/3] Building application...
call npm run tauri build -- --bundles nsis

echo [3/3] Build complete!
echo.
echo Output: src-tauri\target\release\bow-rust.exe
echo Installer: src-tauri\target\release\bundle\nsis\
echo.
echo To run as portable, copy these files to one folder:
echo   - src-tauri\target\release\bow-rust.exe
echo   - WifiUtil.apk (place next to exe)
echo   - adb.exe + AdbWinApi.dll + AdbWinUsbApi.dll (place next to exe)
echo.
pause
