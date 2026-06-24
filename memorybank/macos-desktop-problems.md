# Element Desktop (macOS) — Problem Catalogue

> Source of truth for macOS Element Desktop defects detected from GitHub issues.
> Generated 2026-06-24 via firecrawl research of GitHub + code-mapping against `apps/desktop/src`.

## Methodology & scope

- **Repo pivot:** `element-hq/element-desktop` is effectively archived (**2 open issues**). All active
  desktop development & issues now live in the monorepo **`element-hq/element-web`** under the
  `A-Electron` label (the Electron wrapper = `apps/desktop`).
- **Universe:** 452 open `A-Electron` issues; ~96 mention macOS. We harvested 237 unique issues across
  20 firecrawl/GitHub-search dimensions (impact, severity, and per-subsystem), classified 118 as
  candidate macOS-desktop defects, and deep-code-mapped the top 18 against `apps/desktop/src`.
- **`fixable_in_repo`** = root cause lives in `apps/desktop/src` or `apps/web/src` (we can fix here),
  vs upstream Electron/Chromium/OS or a native module (we can only mitigate/track).
- **impact_score** = severity + frequency + reactions + comments + macOS-specific & wrapper-bug bonuses (0–100).

Legend: 🔴 Critical · 🟠 Major · 🟡 Minor · ⬆️ upstream/blocked · 🍎 macOS-specific

---

## Top problems (ranked by impact)

| #   | Issue                                                                                                             | Subsystem         | Sev | Impact |   macOS    |      Fixable here      | Primary files                             |
| --- | ----------------------------------------------------------------------------------------------------------------- | ----------------- | --- | -----: | :--------: | :--------------------: | ----------------------------------------- |
| 1   | [#32398](https://github.com/element-hq/element-web/issues/32398) Jitsi screensharing doesn't work on desktop      | Screen sharing    | 🟠  |     97 |   partly   |     ✅ (wiring) ⬆️     | electron-main.ts, ipc.ts                  |
| 2   | [#32383](https://github.com/element-hq/element-web/issues/32383) Respect OS Do Not Disturb / Focus                | Notifications     | 🟠  |     93 |     🍎     | ⚠️ needs native module | apps/web Notifier.ts, ipc.ts              |
| 3   | [#32198](https://github.com/element-hq/element-web/issues/32198) Missing Session Data → forced logout             | Session/lifecycle | 🔴  |     85 |     no     |       ✅ partial       | StorageManager.ts, **store.ts**           |
| 4   | [#32373](https://github.com/element-hq/element-web/issues/32373) "Couldn't start capturing media" (mic/cam)       | Media perms       | 🔴  |     85 |     no     |           ✅           | **electron-main.ts**, electron-builder.ts |
| 5   | [#32114](https://github.com/element-hq/element-web/issues/32114) Crash at app close (Ventura/M2)                  | Window/lifecycle  | 🔴  |     83 |     🍎     |  ❌ upstream Electron  | electron-main.ts                          |
| 6   | [#33501](https://github.com/element-hq/element-web/issues/33501) Seshat "Neon SendError" error-dialog spam        | Native search     | 🔴  |     80 |     no     |      ✅ (symptom)      | apps/web EventIndex.ts                    |
| 7   | [#32521](https://github.com/element-hq/element-web/issues/32521) "Unable to restore session" (no pickle key)      | Session/lifecycle | 🔴  |     80 |   shared   |           ✅           | **store.ts**, **ipc.ts**                  |
| 8   | [#32303](https://github.com/element-hq/element-web/issues/32303) Start at login not working                       | Auto-launch       | 🟡  |     75 |   shared   |           ✅           | **auto-launch.ts**                        |
| 9   | [#32715](https://github.com/element-hq/element-web/issues/32715) Missing session data (intermittent)              | Session/lifecycle | 🔴  |     75 |   shared   |           ✅           | **store.ts**, **ipc.ts**                  |
| 10  | [#32228](https://github.com/element-hq/element-web/issues/32228) Window size/position not restored                | Window/lifecycle  | 🟡  |     74 |   shared   |           ✅           | electron-main.ts, store.ts                |
| 11  | [#32355](https://github.com/element-hq/element-web/issues/32355) Desktop doesn't offer to download files          | Files             | 🟠  |     71 |     no     |           ✅           | webcontents-handler.ts                    |
| 12  | [#32287](https://github.com/element-hq/element-web/issues/32287) "Warn before quitting" required by default       | Window/lifecycle  | 🟡  |     71 |     🍎     |           ✅           | electron-main.ts, store.ts                |
| 13  | [#32075](https://github.com/element-hq/element-web/issues/32075) Screen-share toggle crashes app (EC)             | Screen sharing    | 🔴  |     71 |     no     |           ✅           | displayMediaCallback.ts                   |
| 14  | [#32404](https://github.com/element-hq/element-web/issues/32404) /Applications unprivileged user can't autoupdate | Auto-updater      | 🟠  |     67 |     🍎     |       ✅ partial       | updater.ts                                |
| 15  | [#32253](https://github.com/element-hq/element-web/issues/32253) Search doesn't warn when indexing incomplete     | Native search     | 🔴  |     67 |     no     |           ✅           | apps/web + seshat.ts                      |
| 16  | [#32426](https://github.com/element-hq/element-web/issues/32426) Toggle-mute hotkey not working in VoIP           | Shortcuts         | 🟠  |     65 |     no     |           ✅           | vectormenu.ts, electron-main.ts           |
| 17  | [#32108](https://github.com/element-hq/element-web/issues/32108) Unable to restore session → hang on sign-in      | Session/lifecycle | 🔴  |     63 |     no     |      ⚠️ web-side       | store.ts                                  |
| 18  | [#32267](https://github.com/element-hq/element-web/issues/32267) Cmd-W closes window without prompting            | Shortcuts         | 🟠  |     63 |     🍎     |           ✅           | vectormenu.ts, electron-main.ts           |
| 19  | [#32362](https://github.com/element-hq/element-web/issues/32362) "Image failed to save" on Save image as          | Files             | 🟡  |     62 |     no     |           ✅           | webcontents-handler.ts                    |
| 20  | [#32351](https://github.com/element-hq/element-web/issues/32351) System-wide config.json not picked up            | Config            | 🟡  |     62 |     no     |           ✅           | config.ts                                 |
| 21  | [#32260](https://github.com/element-hq/element-web/issues/32260) Window briefly flashes white on launch           | Window/lifecycle  | 🟡  |     62 |   shared   |           ✅           | electron-main.ts                          |
| 22  | [#32352](https://github.com/element-hq/element-web/issues/32352) Can't exit while in call (tray)                  | Tray/Dock         | 🟠  |     62 |     no     |           ✅           | tray.ts, electron-main.ts                 |
| 23  | [#32337](https://github.com/element-hq/element-web/issues/32337) Integration manager config ignored               | Config            | 🟠  |     61 |     no     |           ✅           | config.ts                                 |
| 24  | [#32284](https://github.com/element-hq/element-web/issues/32284) Jitsi server in desktop config ignored           | Config            | 🟠  |     61 |     no     |           ✅           | config.ts                                 |
| 25  | [#32472](https://github.com/element-hq/element-web/issues/32472) Recovery key required every restart              | Session/lifecycle | 🔴  |     61 |     no     |      ⚠️ web-side       | store.ts                                  |
| 26  | [#32315](https://github.com/element-hq/element-web/issues/32315) No way to disable smooth scrolling               | Accessibility     | 🟠  |     61 |     no     |    ⚠️ web/Chromium     | —                                         |
| 27  | [#32341](https://github.com/element-hq/element-web/issues/32341) Search URL in All Rooms fails (Seshat)           | Native search     | 🟠  |     61 |     no     |           ✅           | seshat.ts                                 |
| 28  | [#32038](https://github.com/element-hq/element-web/issues/32038) No i18n tokenization in encrypted search         | Native search     | 🟠  |     61 |     no     |      ⬆️ upstream       | seshat.ts                                 |
| 29  | [#32222](https://github.com/element-hq/element-web/issues/32222) White screen, no UI after switching back         | Window/lifecycle  | 🟠  |     59 |   shared   |           ⚠️           | electron-main.ts                          |
| 30  | [#32119](https://github.com/element-hq/element-web/issues/32119) Seshat pegs CPU 100–200% for 30s                 | Native search     | 🟠  |     59 |     🍎     |      ⬆️ upstream       | seshat.ts                                 |
| 31  | [#32018](https://github.com/element-hq/element-web/issues/32018) Hard to move window (titlebar drag area)         | Title bar         | 🟡  |     59 |     🍎     |           ✅           | macos-titlebar.ts                         |
| 32  | [#32017](https://github.com/element-hq/element-web/issues/32017) Screen share only shares Element / black         | Screen sharing    | 🟠  |     59 |     🍎     |           ✅           | displayMediaCallback.ts                   |
| 33  | [#32184](https://github.com/element-hq/element-web/issues/32184) Nightly update fails (macOS Ventura)             | Auto-updater      | 🟠  |     59 |     🍎     |       ✅ partial       | updater.ts                                |
| 34  | [#32258](https://github.com/element-hq/element-web/issues/32258) Upgraded-room search misses pre-upgrade history  | Native search     | 🟠  |     59 |     no     |           ✅           | seshat.ts                                 |
| 35  | [#32360](https://github.com/element-hq/element-web/issues/32360) Always starts in fullscreen                      | Window/lifecycle  | 🟡  |     56 |     no     |           ✅           | store.ts, electron-main.ts                |
| 36  | [#32266](https://github.com/element-hq/element-web/issues/32266) No encrypted search results despite index        | Native search     | 🟠  |     57 |     no     |           ✅           | seshat.ts                                 |
| 37  | [#32011](https://github.com/element-hq/element-web/issues/32011) Search doesn't find expected messages            | Native search     | 🟠  |     57 |     no     |           ✅           | seshat.ts                                 |
| 38  | [#32223](https://github.com/element-hq/element-web/issues/32223) Shortcut launches new instance after boot        | Window/lifecycle  | 🟡  |     56 | no (Linux) |           ⬆️           | electron-main.ts                          |
| 39  | [#32112](https://github.com/element-hq/element-web/issues/32112) libsqlcipher missing → Seshat fails              | Native search     | 🟠  |     56 |     no     |      ⬆️ packaging      | seshat.ts                                 |
| 40  | [#32356](https://github.com/element-hq/element-web/issues/32356) Search doesn't render edited messages            | Native search     | 🟠  |     56 |     no     |           ✅           | seshat.ts                                 |
| 41  | [#32343](https://github.com/element-hq/element-web/issues/32343) Search misses certain non-stopwords              | Native search     | 🟠  |     56 |     no     |           ✅           | seshat.ts                                 |
| 42  | [#32288](https://github.com/element-hq/element-web/issues/32288) Remove "99+" dock badge cap                      | Dock badge        | 🟡  |     56 |     🍎     |           ✅           | badge.ts                                  |
| 43  | [#32273](https://github.com/element-hq/element-web/issues/32273) UI frozen after "Open" on download toast         | Window/lifecycle  | 🟠  |     56 |     no     |           ✅           | webcontents-handler.ts, ipc.ts            |
| 44  | [#31996](https://github.com/element-hq/element-web/issues/31996) Notification sounds stack after wake (Sequoia)   | Notifications     | 🟡  |     54 |     🍎     |           ⚠️           | badge.ts                                  |
| 45  | [#32130](https://github.com/element-hq/element-web/issues/32130) Illegal instruction on Skylake (GDS)             | Native search     | 🔴  |     54 | no (Linux) |      ⬆️ upstream       | seshat.ts                                 |

---

## Code-grounded root causes (top fixable defects)

### 🔴 Pickle-key transient decrypt → permanent session loss — #32521 / #32715 / #32198 (secondary)

- **Root cause (in-repo):** `SafeStorageWriter.get()` ([store.ts:115-126](../apps/desktop/src/store.ts))
  catches `safeStorage.decryptString` failures, logs, and **returns `undefined`** — indistinguishable
  from "no secret stored". The OS keychain can be momentarily unavailable/locked, or the keychain ACL
  invalidated by an app re-sign/update, so an _existing valid_ secret reads as absent.
  `getPickleKey` ([ipc.ts:110-118](../apps/desktop/src/ipc.ts)) then returns `null` → renderer falls
  back to the **default** pickle key ("missing session data"). Worse, `createPickleKey`
  ([ipc.ts:120-129](../apps/desktop/src/ipc.ts)) then **overwrites** the still-valid-but-unreadable
  ciphertext with a brand-new key → a transient hiccup becomes **permanent** session/crypto loss.
- **Fix:** distinguish "absent" from "present-but-undecryptable" (typed error); never overwrite an
  undecryptable existing secret. **← FIXED THIS SESSION** (see activity log).

### 🔴 IndexedDB eviction → forced logout / recovery-key re-entry — #32198 / #32108 (also #32472)

- **Root cause (confirmed by maintainer logs):** the crypto store (Olm/Megolm + cross-signing keys) lives in
  IndexedDB. If the origin is not "persistent" (durable), Chromium evicts it LRU under storage pressure →
  `checkConsistency()` ([StorageManager.ts:92-98](../apps/web/src/utils/StorageManager.ts)) trips its "evicted"
  branch ("IndexedDB storage has likely been evicted by the browser!") → `Lifecycle.doSetLoggedIn` shows
  `StorageEvictedDialog` and forces sign-out (#32198/#32108); re-login then needs the recovery key (#32472).
  `tryPersistStorage()` requested `navigator.storage.persist()` but **only logged** the boolean — never acting
  on a `false` result. On a custom-scheme (`vector:`) Electron renderer Chromium's durable-storage heuristic
  **commonly returns false** (no engagement/bookmark/notification signal), so the eviction risk was silent.
- **Fix (web-side, Phase 0.3 — FIXED session 5):** `tryPersistStorage()` → `async Promise<boolean>`; check
  `persisted()` first + short-circuit; query failure no longer blocks the request; warn (`logger.warn`,
  rageshake-captured, desktop-aware via `window.electron`) on denial; never rejects. **Limit:** there is **no
  Electron main-process API** to force per-origin durability (`persistent-storage` is not grantable; no session
  quota-grant); the only lever is the notifications permission. The web change improves observability + warns
  but cannot itself make storage durable — a true cure needs a main-process/upstream follow-up.

### 🟠 Jitsi screenshare double-picker on macOS — #32398 (also #32017)

- **Root cause:** [electron-main.ts:527-548](../apps/desktop/src/electron-main.ts) registers
  `setDisplayMediaRequestHandler` with `{ useSystemPicker: true }` (macOS 15+ native picker) **but**
  the non-Wayland branch _also_ sends `openDesktopCapturerSourcePicker` and stores the callback — so on
  macOS two pickers fight. `desktopCapturer.getSources` often returns no windows (TCC / native-picker),
  giving the empty list; the dummy `{id:'',name:''}` source resolves to no real track. Labeled
  `Z-Upstream`/`X-Blocked`. **Fix (medium-risk):** one picker per platform; gate custom picker behind
  `process.platform !== 'darwin'`; verify `getMediaAccessStatus('screen')`.

### 🔴 Mic/camera capture fails on macOS — #32373

- **Root cause:** wrapper never bridges Chromium `getUserMedia` to macOS TCC: no
  `setPermissionCheckHandler`/`setPermissionRequestHandler`, no `systemPreferences.askForMediaAccess`,
  and `electron-builder.ts` mac block lacks `NSMicrophoneUsageDescription`/`NSCameraUsageDescription`
  under hardened runtime. **Fix:** add permission handlers (scoped to app origin) + Info.plist strings.

### 🟡 Start-at-login broken — #32303

- **Root cause:** delegates to the unmaintained `auto-launch@^5.0.5` package
  ([auto-launch.ts](../apps/desktop/src/auto-launch.ts)); its macOS LaunchAgent plist path resolution
  for `.app` bundles is fragile and not refreshed on update. **Fix:** use Electron native
  `app.setLoginItemSettings`/`getLoginItemSettings`. **← FIXED THIS SESSION.**

### 🔴 Seshat error-dialog spam — #33501

- **Root cause:** native Tantivy writer-thread panic is upstream (matrix-org/seshat#173), but the
  _symptom_ is in-repo: `EventIndex.onSync` (apps/web) calls `logErrorAndShowErrorDialog`
  unconditionally on every `/sync` (regression from PR #31448) → modal every sync.
  **Fix:** circuit-breaker — show once, stop indexing, offer "disable message search".

### ⚠️ Notifications ignore macOS DND/Focus — #32383

- **Root cause:** Element plays its **own** in-renderer sound (`Notifier.playAudioNotification`) and
  sets OS banners `silent:true`; the self-played web-audio bypasses macOS Focus. No code reads DND
  state. **Fix needs a native module** (maintainers wary) — track, don't rush.

### ❌ Crash on close (Ventura/M2) — #32114

- **Root cause:** native `EXC_BAD_ACCESS` in `objc_msgSend` via `NSMenuItem` → Electron/V8 teardown.
  No repo JS frames. **Upstream Electron**; primary fix is the Electron version bump already in-repo.
  Optional defensive hardening only (tray.destroy on quit, listener guards).

---

## Subsystem index (all 45)

- **Session / storage / lifecycle:** 32198, 32521, 32715, 32108, 32472, 32228, 32360, 32260, 32222, 32273, 32114
- **Calls / media / screen-share:** 32398, 32373, 32075, 32017, 32426
- **Native search (Seshat):** 33501, 32253, 32341, 32258, 32266, 32011, 32356, 32343, 32038, 32119, 32112, 32130
- **Auto-launch / auto-update:** 32303, 32404, 32184
- **Notifications / badge:** 32383, 31996, 32288
- **Files / downloads:** 32355, 32362, 32273
- **Config:** 32351, 32337, 32284
- **Title bar / window chrome:** 32018, 32287, 32267
- **Tray/Dock:** 32352, 32288
- **Accessibility / misc:** 32315
