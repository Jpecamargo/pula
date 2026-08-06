<img src="icons/icon128.png" alt="Pula" width="128" height="128">

# Pula — Skip YouTube Ads and Streaming Intros with a DOM-Only Chrome Extension

A Manifest V3 (MV3) Chrome extension that skips YouTube ads by clicking the same
buttons you would click yourself, and mutes, hides and skips through ad breaks,
intros and recaps on Netflix, Prime Video, Disney+, Max, Twitch, Globoplay,
Crunchyroll and Paramount+.

No network blocking. No request filtering. No external servers. Nothing to sign
up for.

[Leia em português (pt-BR)](README.pt-BR.md)

## Why I built this

I play with a video or a music mix running on a second screen. That worked fine
until an ad rolled: I had to put the controller down, reach for the mouse, drag
the pointer over to the other monitor, hunt for "Skip ad", click it, and go back
to the game — which by then had usually gone badly for me. Pausing the game to
skip an ad twenty times an evening is a stupid way to spend an evening.

So I wrote something that clicks the button for me. That is the whole idea, and
it is why the extension works the way it does: it does not fight YouTube's ad
system, it just does the mouse work I was doing by hand. If a human could do it
with a mouse in the page, Pula does it. If a human could not, Pula does not
pretend otherwise.

## What it does, per service

YouTube is the exception among streaming sites: there, an ad is a **separate
`<video>` element** with its own duration and a real "Skip ad" button, so it can
genuinely be skipped — click the button, or push the playhead to the end.

Everywhere else the ads are **SSAI** (server-side ad insertion): the ad is
stitched into the same stream as the show. There is no ad element, and the player
rejects any attempt to seek past the break — insisting on that would just spin in
a click loop. What actually works there is muting the break, hiding the ad
overlay and countdown, and clicking "Skip intro" / "Skip recap" / "Next episode"
when the episode itself offers them.

Pula clicks a skip-ad button too, whenever one shows up: most of the inventory on
these services has no such button, but some ad formats do, and clicking it is the
same gesture you would make with the mouse. When there is no button, the lookup
simply finds nothing and the break stays muted.

| Service | How ads are served | Clicks a skip button | Mutes ad + hides overlay | Skips intro / recap / next episode |
|---|---|---|---|---|
| YouTube | separate ad video | yes — clicks "Skip ad", fast-forwards unskippable ads | yes | n/a |
| Netflix | SSAI | when the site shows one | yes | yes |
| Prime Video | SSAI | when the site shows one | yes | yes |
| Disney+ | SSAI | when the site shows one | yes | yes |
| Max | SSAI | when the site shows one | yes | yes |
| Twitch | SSAI | when the site shows one | yes | n/a |
| Globoplay | SSAI | when the site shows one | yes | yes |
| Crunchyroll | SSAI | when the site shows one | yes | yes |
| Paramount+ | SSAI | when the site shows one | yes | yes |

On top of that, on YouTube specifically:

- Hides ad overlays on the player and ads in the feed, home, sidebar and masthead
- Auto-confirms the "Video paused. Continue watching?" dialog
- Dismisses the anti-adblock modal if it shows up as a false positive
- Skips **sponsor chapters** using the video's own chapter list — no server, no
  third-party API, no account. It is SponsorBlock-shaped, without the network
  call
- Warns in the console when the selectors break, with the button candidates it
  found, so you know exactly what to fix

The popup gives you a toggle **per streaming service** and a toggle **per
behavior**, plus a counter for ads skipped, time saved and sponsor segments
skipped. Toggles apply immediately, with no page reload.

## Why no network blocking matters

Pula never touches `webRequest`, `declarativeNetRequest` or host permissions. The
page loads the ad exactly as it normally would, and the extension only interacts
with the resulting DOM.

That is deliberate. Ad-block detection works by noticing that a request failed or
that an expected element never appeared. If nothing is blocked, there is no
signal to detect, so the anti-adblock enforcement has nothing to trigger on. It
also means the extension cannot break playback by starving the player of a
resource it needed.

`storage` is the only permission in the manifest, and it exists purely so the
popup can remember your toggles and the counter.

## Install (load unpacked)

There is no build step and no dependencies. The repository is the extension.

1. Open `chrome://extensions`
2. Turn on **Developer mode** (top right)
3. **Load unpacked** and select the `pula/` folder (the folder, not
   `manifest.json`)
4. Open a video. If the tab was already open, reload it — content scripts are
   only injected into navigations that happen after the install

To confirm it is running, set `debug: true` in `CONFIG` (top of `core.js`, or via
the popup's debug toggle) and filter the DevTools console for `[Pula]`.

## Reloading after you edit

The reload button alone is not enough: it reloads the extension package, but the
open tab still holds the previously injected copy of the content script.

| Edited | What to do |
|---|---|
| `core.js` or `adapters/*.js` | Reload button on the extension card in `chrome://extensions` **and** F5 on the streaming tab |
| `popup.html` / `popup.js` | Close and reopen the popup (reload button only if that does not take) |
| `_locales/*/messages.json` | Reload button, then reopen the popup |
| `manifest.json` | Reload button, then F5. If Chrome complains, remove the extension and load it again |
| `icons/` | Reload button (may need a hard reload of the `chrome://extensions` page) |

Handy setup: keep `chrome://extensions` pinned in its own tab and edit the folder
directly. There is no watcher, but reload plus F5 takes two seconds.

## Layout

```
pula/
├── manifest.json      # MV3, content scripts at document_start, storage permission
├── core.js            # the generic engine: tick loop, mute, stats, CSS, config
├── adapters/          # one file per streaming service (see adapters/README.md)
├── popup.html         # toggles and counter UI
├── popup.js           # reads/writes chrome.storage.local
├── _locales/          # en and pt_BR UI strings
└── icons/             # icon16.png, icon48.png, icon128.png
```

The three PNGs are mandatory while `manifest.json` declares the `icons` block —
Chrome refuses to load an extension that references a missing file.

## When it breaks

Streaming sites rename their CSS classes, and that is the usual way a DOM-based
ad skipper stops working. When it happens you get a console warning like
`[Pula:netflix] ad active for more than ...` listing every button that exists
inside the ad container at that moment. The prefix tells you which adapter is
talking, and the correct selector is almost always in that list — put it at the
top of that adapter's `skipButtonSelectors`.

If no warning shows up but the ad disappears anyway, the text-based fallback is
carrying it: Pula also scans buttons inside the ad containers and picks by their
label (Portuguese, English and Spanish), which survives most class renames. It is
still worth updating the selector.

Behavior toggles live in the popup, not in the source. Note that the popup writes
over `CONFIG`: if you edit a boolean in the file and nothing changes, that key is
already stored in `chrome.storage` — change it from the popup instead.

Adding support for another service means adding one adapter file and one entry in
the manifest. The contract is documented in [`adapters/README.md`](adapters/README.md).

## Scope and disclaimer

This is a personal-use project, written for my own setup and shared as-is. It is
not on the Chrome Web Store, it is not audited, and it will break whenever a
streaming site reshuffles its DOM. Consider supporting the creators you watch —
the point of this thing was never to avoid paying for content, it was to stop
pausing my game.
