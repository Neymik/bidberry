# WB Partners Automation

## Project Goal
Automate the WB Partners (Wildberries) mobile Android app to count orders and extract data.

## Architecture
- **Android Emulator** running locally on macOS (Apple Silicon / arm64)
- **Python + uiautomator2** for UI automation and data extraction
- **ADB** for device/app management
- **pytesseract** as OCR fallback when UI hierarchy doesn't expose text

## Emulator Setup
- **AVD Name:** `wb_auto`
- **Device:** Pixel 6
- **Image:** `system-images;android-34;google_apis_playstore;arm64-v8a` (Android 14 with Play Store)
- **AVD Path:** `~/.android/avd/wb_auto.avd/`
- **Data is persistent** across restarts (don't use `-wipe-data`)

## Environment
- **ANDROID_HOME:** `/opt/homebrew/share/android-commandlinetools`
- **Java:** JDK 20 (system-installed at `/usr/bin/java`)
- **Platform:** macOS Darwin arm64

### Required PATH additions (~/.zshrc)
```bash
export ANDROID_HOME="/opt/homebrew/share/android-commandlinetools"
export PATH="$PATH:$ANDROID_HOME/emulator:$ANDROID_HOME/platform-tools:$ANDROID_HOME/cmdline-tools/latest/bin"
```

## Commands

### Launch emulator (with GUI, for login/setup)
```bash
emulator -avd wb_auto -gpu host -no-boot-anim &
```

### Launch emulator (headless, for automation)
```bash
emulator -avd wb_auto -no-window -no-audio -no-boot-anim -gpu swiftshader_indirect &
```

### Wait for boot
```bash
adb wait-for-device shell 'while [[ -z $(getprop sys.boot_completed | tr -d "\r") ]]; do sleep 2; done'
adb shell input keyevent 82  # unlock screen
```

## Python Dependencies
```
uiautomator2
pytesseract
Pillow
```

## WB Partners App
- Installed via Google Play Store on the emulator
- Package name: TBD (check with `adb shell pm list packages | grep wildberries`)
