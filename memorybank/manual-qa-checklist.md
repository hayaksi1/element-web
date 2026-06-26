# macOS Desktop — Manual QA Checklist (P2)

> For the ~15 landed fixes whose behaviour is **not unit-testable** (live macOS GUI / native).
> Run against a fresh build: see [element-desktop-build-recipe](../) (memory) — rebuild after the
> #33954 seshat relink (session 16). Mark each ✅/❌ and note the build version.
> Generated session 16 (2026-06-25). Cross-ref [phases.md](phases.md) for root-cause detail.

## How to build & run the test app

```
cd apps/desktop
corepack pnpm run fetch develop -d ''          # renderer (webapp.asar)
corepack pnpm run build:native                 # seshat WITH --cfg aes_armv8 (#33954)
./node_modules/.bin/tsc && node scripts/copy-res.ts
CSC_IDENTITY_AUTO_DISCOVERY=false NODE_OPTIONS="--max-old-space-size=8192" \
  ./node_modules/.bin/electron-builder --mac --arm64
open dist/mac-arm64/Element.app
```

Logs: `~/Library/Application Support/Element/logs/` (rageshake) + Console.app filtered by "Element".

---

## Priority A — data-loss / blocker class (verify first)

- [ ] **#32521/#32715/#32198 pickle-key guard** — sign in; quit; **lock the login keychain** (Keychain
      Access → lock) or temporarily revoke keychain ACL; relaunch. **Expect:** NOT logged out / "missing
      session data"; secret is NOT overwritten (transient decrypt failure tolerated). Unlock keychain →
      next launch reads the secret normally. (`store.ts`/`ipc.ts`)
- [ ] **#32373 mic/cam capture** — first-ever call: macOS shows the TCC mic + camera prompts; grant →
      audio/video works. Deny then re-grant in System Settings → Privacy → next call works. **Widget/Jitsi
      call** (cross-origin iframe) also gets media (handler is fail-open, NOT origin-scoped). (`media-permissions.ts`)
- [ ] **#33501 Seshat error-dialog spam** — if the native Tantivy writer panics, the error dialog appears
      **once**, indexing stops; it does **not** re-pop after every sync. (`EventIndex.ts`)
- [ ] **#32198/#32472 storage durability (observability only)** — check `logger.warn` in rageshake logs
      on `persist()==false`; confirm no per-login user-facing toast flood. (Web ceiling — durability itself
      can't be forced; see phases 0.3.)

## Priority B — calls / media

- [ ] **#32398/#32017 screen share** — on macOS 15+, sharing uses the **native** system picker; pick a
      window/screen → the _correct_ surface streams (not just Element / not black). Cancel the picker →
      clean cancel, no dangling state, app stays responsive. (`displayMediaCallback.ts`/`ipc.ts`)
- [ ] **#32075 screen-share toggle** — toggle screen-share on/off repeatedly mid-call → no crash.

## Priority C — window / lifecycle / quit UX

- [ ] **#32267 ⌘W** — press ⌘W with one window → the **whole app hides** (like ⌘H), another app becomes
      frontmost; Element is NOT left frontmost with an empty menu bar ("limbo"). Reopen from dock → restores.
- [ ] **#32287 ⌘Q / menu Quit / tray Quit** — default (warn OFF on macOS): ⌘Q quits immediately, no
      prompt. Enable "Warn before quitting" in Settings → ⌘Q **and** menu File→Quit **and** tray Quit all
      show the confirm dialog (no silent bypass). (`confirm-quit.ts`)
- [ ] **#32228/#32360 window geometry** — resize + move window; **force-quit** (or crash) the app; relaunch
      → bounds restored (not just on clean quit). Quit while **fullscreen** → relaunch starts **windowed**,
      NOT fullscreen. Move window across a **2nd monitor**, quit, unplug monitor, relaunch → window appears
      on-screen (not lost off-screen). (`window-state.ts`)
- [ ] **#32260 white flash** — set **dark** theme; fully quit; relaunch → no white flash before the dark UI
      paints (window opens already dark). Repeat with light theme. (`background-color.ts`)
- [ ] **#32222 renderer crash recovery** — if the renderer crashes (white screen), it auto-reloads; after
      3 crashes / 60s a dialog appears instead of an infinite reload loop. Relaunch from dock after a crash
      doesn't re-arm a given-up loop. (`renderer-recovery.ts`) — hard to force; watch logs for `render-process-gone`.

## Priority D — files / config / chrome

- [ ] **#32362 Save image as** — right-click an image in an **encrypted/authenticated** room → "Save image
      as" → file saves correctly (no 401/404, no "Image failed to save"). (`save-image.ts`)
- [ ] **#32355 download offer** — click a file attachment → native Save dialog appears.
- [ ] **#32273 download-toast Open** — download a file → click "Open" on the toast → opens; if the open
      **fails** (e.g. no handler), an error dialog shows (not silent). (`user-download.ts`)
- [ ] **#32351 system-wide config** — place a `config.json` at
      `/Library/Application Support/<productName>/config.json`; launch with no per-user config → settings are
      picked up. Per-user `userData/config.json` overrides it. A malformed machine-wide file is skipped
      (logged), does NOT brick the session. (`config.ts`)
- [ ] **#32018 title-bar drag** — click-drag the empty band at the very top of the window (above the room
      header / left panel) → window moves (drag area is now 32px, was ~13px). No control becomes un-clickable.
- [ ] **#32315 smooth scrolling** — enable Settings → Accessibility "disable smooth scrolling" (or set OS
      Reduce Motion) → room-list jump-to and session-manager scrolls are instant, not animated.

## Priority E — search correctness (needs an encrypted room with history)

- [ ] **#33954 seshat hardware AES (perf)** — index a large encrypted room; watch Activity Monitor → the
      Seshat/indexing thread CPU should be markedly lower than a pre-#33954 build (HW AES). Functionally:
      search still returns correct results. (Confirmed at instruction level session 16 — see activity log.)
- [ ] **#32266/#32011 backfill completeness** — encrypted room with history but no prior index → after
      launch, `reconcileMissedRooms` seeds a crawl; search eventually finds old messages. ManageEventIndex
      dialog shows "N indexed, M indexing[, K errored]".
- [ ] **#32341 All-Rooms URL/colon search** — search a term containing a URL or a colon (`http://`, `foo:bar`)
      in All Rooms → no "Search failed"; returns results from the surviving leg.
- [ ] **#32258 upgraded-room history** — in a room that was upgraded (has a predecessor) → search finds
      messages from **before** the upgrade.
- [ ] **#32356 edited messages** — search a term that only appears in the **edited** version of a message →
      the result renders the message (not blank).
- [ ] **#32038 CJK / N-gram** — set `tokenizerMode: ngram` (config.json or device setting) → index rebuilds;
      search for CJK substrings / non-stopwords returns hits.

---

## Not QA-able here / out of scope (track only)

#32114 (upstream Electron crash), #32184 (Squirrel.Mac native), #32426 (element-call iframe),
#32223 (Linux), #32288 ("99+" is macOS-native), #32119/#32112/#32130 (upstream seshat),
0.3 true durability (no Electron API). See [phases.md](phases.md) Phase tail.
</content>
</invoke>
