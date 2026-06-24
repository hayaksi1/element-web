# Element Desktop (macOS) — Phased Remediation Plan

Ordered highest → lowest priority. Priority = severity × frequency × user-impact, weighted toward
defects whose root cause is **fixable in this repo** and **unit-testable** without a live macOS GUI.
See [macos-desktop-problems.md](macos-desktop-problems.md) for full root-cause detail.

Status keys: ✅ done · 🔜 next · ⏳ planned · ⬆️ upstream/track-only · ⚠️ needs design/native module

---

## Phase 0 — Critical data-loss & launch blockers ★ HIGHEST

The worst class: users silently lose their session / encrypted history.

| #   | Issue                    | Action                                                                                                                                                       | Status                   |
| --- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------ |
| 0.1 | #32521 / #32715 / #32198 | **Pickle-key transient-decrypt guard** in `store.ts` + `ipc.ts`: distinguish absent vs undecryptable; never overwrite an undecryptable secret. + unit tests. | ✅ **done this session** |
| 0.2 | #33501                   | Seshat error-dialog **circuit-breaker** in apps/web `EventIndex.ts` (show the dialog once, then stop indexing — no flood after every `/sync`).               | ✅ **done (session 2)**  |
| 0.3 | #32198 / #32472 / #32108 | Harden web-side `StorageManager.tryPersistStorage()` (act on the `persistent` boolean; warn on desktop; recovery before forced logout).                      | ⏳ planned               |

## Phase 1 — Calls / media (screen-share + mic/camera) ★ HIGH

Blocks core real-time comms; #32398 is the single highest-impact issue (97).

| #   | Issue           | Action                                                                                                                                                                                                                     | Status     |
| --- | --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| 1.1 | #32373          | macOS media permissions: `setPermissionCheckHandler`/`RequestHandler` (scoped to app origin), `askForMediaAccess` on darwin, add `NS*UsageDescription` in `electron-builder.ts`. + unit tests.                             | 🔜 next    |
| 1.2 | #32398 / #32017 | Screen-share: one picker per platform — gate the custom `openDesktopCapturerSourcePicker` behind `process.platform !== 'darwin'` when `useSystemPicker` is honoured; clean cancel path. (Z-Upstream — verify on macOS 15.) | ⏳ planned |
| 1.3 | #32075          | Guard the screen-share picker toggle crash (stale `displayMediaCallback`).                                                                                                                                                 | ⏳ planned |
| 1.4 | #32426          | Wire toggle-mute hotkey through the menu/accelerator path.                                                                                                                                                                 | ⏳ planned |

## Phase 2 — Auto-launch & auto-update ★ HIGH (frequent, cross-platform)

| #   | Issue  | Action                                                                                                                                                           | Status                   |
| --- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| 2.1 | #32303 | **Rewrite `auto-launch.ts`** onto native `app.setLoginItemSettings`/`getLoginItemSettings`; preserve `AutoLaunchState` API + `--hidden`/minimised. + unit tests. | ✅ **done this session** |
| 2.2 | #32404 | macOS: detect non-writable `/Applications` install; surface clear guidance instead of silent auto-update failure.                                                | ⏳ planned               |
| 2.3 | #32184 | Investigate Nightly feed/`releases.json` handling in `updater.ts`.                                                                                               | ⏳ planned               |

## Phase 3 — Window / lifecycle / quit UX

| #   | Issue           | Action                                                                               | Status                   |
| --- | --------------- | ------------------------------------------------------------------------------------ | ------------------------ |
| 3.1 | #32287          | `warnBeforeExit` default → opt-in on macOS (CMD+Q immediate by default).             | ⏳ planned               |
| 3.2 | #32267          | Cmd-W should not orphan the window without prompting; route through quit/hide logic. | ⏳ planned               |
| 3.3 | #32228 / #32360 | Persist & restore maximized/fullscreen state reliably (hide-to-tray vs close).       | ⏳ planned               |
| 3.4 | #32260          | Remove white launch flash (`backgroundColor`/`show` timing).                         | ⏳ planned               |
| 3.5 | #32352          | Tray "Exit" works during a call.                                                     | ⏳ planned               |
| 3.6 | #32273          | UI freeze after "Open" on download toast (`shell.openPath` / focus).                 | ⏳ planned               |
| 3.7 | #32114          | Crash on close (Ventura/M2).                                                         | ⬆️ track (Electron bump) |
| 3.8 | #32222 / #32223 | White-screen-on-return; single-instance focus after boot.                            | ⬆️ investigate/upstream  |

## Phase 4 — Native search (Seshat) quality cluster

| #   | Issue                                               | Action                                                                                | Status             |
| --- | --------------------------------------------------- | ------------------------------------------------------------------------------------- | ------------------ |
| 4.1 | #32253                                              | Warn the user when searching before indexing is complete.                             | ⏳ planned         |
| 4.2 | #32341 / #32258 / #32266 / #32011 / #32356 / #32343 | Query/index correctness bugs — triage as a batch against `seshat.ts` + matrix-seshat. | ⏳ planned         |
| 4.3 | #32038 / #32119 / #32112 / #32130                   | i18n tokenization, CPU spikes, packaging, Skylake illegal-instruction.                | ⬆️ mostly upstream |

## Phase 5 — Notifications & badge

| #   | Issue  | Action                                                                        | Status          |
| --- | ------ | ----------------------------------------------------------------------------- | --------------- |
| 5.1 | #32383 | Respect macOS DND/Focus (needs vetted native module + IPC + renderer gating). | ⚠️ needs design |
| 5.2 | #31996 | macOS Sequoia: notification sounds stack after wake.                          | ⏳ investigate  |
| 5.3 | #32288 | Remove "99+" dock badge cap.                                                  | ⏳ planned      |

## Phase 6 — Files, config, title bar, accessibility

| #   | Issue                    | Action                                                                                      | Status          |
| --- | ------------------------ | ------------------------------------------------------------------------------------------- | --------------- |
| 6.1 | #32355 / #32362          | Blob/anchor downloads not promoted to the session pipeline; Save-image-as failure.          | ⏳ planned      |
| 6.2 | #32351 / #32337 / #32284 | config.json override/loading defects (system-wide path, integration manager, jitsi domain). | ⏳ planned      |
| 6.3 | #32018                   | macOS title-bar draggable area too small (`macos-titlebar.ts`).                             | ⏳ planned      |
| 6.4 | #32315                   | Disable smooth scrolling (accessibility).                                                   | ⬆️ web/Chromium |

---

### Session 1 fixes (2026-06-24)

- ✅ **0.1** Pickle-key transient-decrypt data-loss guard (`store.ts`, `ipc.ts`, `store.test.ts`)
- ✅ **2.1** Start-at-login via native Electron loginItem API (`auto-launch.ts`, `auto-launch.test.ts`)

### Session 2 fixes

- ✅ Committed + pushed session 1 work to `origin/main`.
- ✅ **0.2** Seshat error-dialog **circuit-breaker** (`apps/web/src/indexing/EventIndex.ts`): `onSync` now shows
  the error dialog **once**, sets an `indexingErrored` flag, stops the crawler, and skips further indexing —
  fixing the dialog flood (#33501, S-Critical). Tests added to `EventIndex-test.ts` (now 4 pass).

### Recommended next session

- **1.1** macOS media (mic/cam) permissions (#32373) — `electron-main.ts` permission handlers + `NS*UsageDescription`.
- Then **0.3** harden web-side `StorageManager.tryPersistStorage()`, or **Phase 1.2/1.3** screen-share.
