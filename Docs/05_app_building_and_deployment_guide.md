# Kraveo Mobile App Build & Deployment Guide: Android (APK/AAB) & iOS (IPA)

This document provides a complete guide on how Flutter builds physical app packages for Android and iOS, how to test them on phones, and how to automate releases.

---

## 📦 1. App Binary Package Types Explained

| Platform | File Extension | Purpose | How it is Installed / Distributed |
| :--- | :--- | :--- | :--- |
| **Android APK** | `.apk` | Universal Android installer package | Direct USB install, WhatsApp/Drive link, side-loading on test devices |
| **Android AAB** | `.aab` | Android App Bundle (Play Store Standard) | Uploaded to Google Play Console for official Play Store publishing |
| **iOS IPA** | `.ipa` | iOS App Store Package | Distributed via Apple TestFlight or uploaded to Apple App Store Connect |

---

## 🤖 2. Building Android APKs & App Bundles

Since you write code in Flutter, a single command compiles your Dart code into native ARM/x86 machine code for Android.

### Step-by-Step Commands:

#### A. Build Universal Android APK (For Immediate Testing on Phones)
Navigating into any app directory and running:

```bash
# Customer App APK
cd apps/customer_app
flutter build apk --release

# Vendor App APK (For Dhaba Owners)
cd apps/vendor_app
flutter build apk --release

# Delivery App APK (For Student Runners)
cd apps/driver_app
flutter build apk --release
```

- **Output File Location:** `build/app/outputs/flutter-apk/app-release.apk`
- **How to Test:** Copy this `.apk` file to any Android phone (via USB, Google Drive, or WhatsApp) and tap to install!

#### B. Build Split APKs (Smaller File Size per Device Architecture)
```bash
flutter build apk --split-per-abi
```
Generates 3 lightweight APKs targeted specifically for modern 64-bit phones (`arm64-v8a`), older phones (`armeabi-v7a`), and emulators (`x86_64`).

#### C. Build App Bundle for Google Play Store Publishing
```bash
flutter build appbundle --release
```
- **Output File Location:** `build/app/outputs/bundle/release/app-release.aab`
- **Publishing:** Uploaded directly to your Google Play Console account.

---

## 🍏 3. Building iOS IPAs (iPhone & iPad)

Building iOS applications requires a macOS environment with Apple's official **Xcode** IDE and an **Apple Developer Account** ($99/year).

### Step-by-Step Commands (on a Mac):

```bash
cd apps/customer_app
flutter build ipa --release
```

- **Output File Location:** `build/ios/archive/Runner.xcarchive` & `build/ios/ipa/customer_app.ipa`
- **Beta Testing:** Uploaded to **Apple TestFlight** where student beta testers can install it directly from an email invitation.

---

## ☁️ 4. How to Build iOS Apps on Linux (Cloud CI/CD Workaround)

If you are developing on Linux, **you do NOT need to buy a Mac right now**. You can use automated cloud build pipelines:

### Option A: GitHub Actions (Free Mac Cloud Builders)
We set up a `.github/workflows/build.yml` in your private GitHub repository.
1. You push code to GitHub (`git push origin main`).
2. GitHub automatically spins up a macOS virtual machine in the cloud.
3. It installs Flutter, compiles `.apk` and `.ipa` files, and attaches them to a GitHub Release or sends them to TestFlight!

### Option B: Codemagic / Bitrise
Dedicated mobile CI/CD platforms designed specifically for Flutter that automatically build and sign Android APKs and iOS IPAs on every git commit.

---

## 📲 5. Immediate Local Testing Setup

To test your Flutter apps live on a real Android phone via USB:

1. Enable **Developer Options** on your Android phone (Settings -> About Phone -> Tap "Build Number" 7 times).
2. Turn on **USB Debugging**.
3. Plug your phone into your computer via USB.
4. Run:
   ```bash
   flutter devices
   # Your phone will show up as a connected device!
   
   cd apps/customer_app
   flutter run -d <your_device_id>
   ```
   The app will automatically compile, install, and open on your physical phone with hot reload enabled!
