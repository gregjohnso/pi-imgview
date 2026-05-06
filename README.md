# Imgview Extension

Show images from inside [pi][pi]: render them inline in the terminal
(iTerm2 / Kitty / WezTerm / Ghostty), open them in the system browser,
or both.

The LLM gets a single tool, `show_image`, with a `mode` switch. You also
get three slash commands (`/imgcat`, `/imgshow`, `/imgboth`) for driving
the same code path by hand.

> Why a separate tool when pi-tui can already render image attachments?
> Because the LLM has no way to *attach* an image on its own initiative.
> `show_image` is the bridge: it takes a path/URL, loads bytes,
> sniffs the MIME, and returns a tool result with `{ type: "image", … }`
> content — which pi-tui then renders inline using the host terminal's
> image protocol. For terminals without image support, the browser path
> is a reliable fallback.

## Install

```bash
# from npm
pi install npm:@gregjohnso/pi-imgview

# or directly from git
pi install git:github.com/gregjohnso/pi-imgview
```

Then `/reload` inside pi, or start a new session.

To develop locally, symlink this repo into your extensions directory:

```bash
ln -s /absolute/path/to/pi-imgview/extensions/imgview ~/.pi/agent/extensions/imgview
```

## Tools exposed to the LLM

| Tool         | Purpose                                                              |
| ------------ | -------------------------------------------------------------------- |
| `show_image` | Display an image inline in the terminal and/or in the user's browser |

### `show_image` parameters

| Param     | Type   | Default     | Meaning                                                                                        |
| --------- | ------ | ----------- | ---------------------------------------------------------------------------------------------- |
| `source`  | string | —           | Local path (absolute, relative-to-cwd, or `~/...`), `http(s)://` URL, or `data:` URI.          |
| `mode`    | enum   | `terminal`  | `terminal` \| `browser` \| `both`.                                                             |
| `caption` | string | —           | Optional one-line note shown alongside the image.                                              |

Returned content:

- A text summary (source label, MIME, byte count, mode, caption, browser
  path if any).
- For `terminal` and `both`: an `{ type: "image", data, mimeType }` part
  that pi-tui renders inline using the host terminal's image protocol.
  Pi-tui auto-converts non-PNG to PNG when the host uses the Kitty
  graphics protocol; iTerm2-family terminals consume the bytes directly.

## User commands

| Command                      | Effect                                                |
| ---------------------------- | ----------------------------------------------------- |
| `/imgcat <path\|url>`        | Render the image inline in the terminal.              |
| `/imgshow <path\|url>`       | Open the image in the system's default browser.       |
| `/imgboth <path\|url>`       | Both.                                                 |

`<path|url>` may be:
- a local file (absolute, relative to cwd, or `~/...`)
- an `http://` / `https://` URL (downloaded and sniffed)
- a `data:` URI

## Browser opening

Browser mode writes a tiny self-contained HTML viewer (image embedded as
a base64 data URI) to `$TMPDIR/pi-imgview/imgview-<id>.html` and then:

| Platform | Command                |
| -------- | ---------------------- |
| macOS    | `open <html>`          |
| Linux    | `xdg-open <html>`      |
| Windows  | `cmd /c start "" <html>` |

HTML files inherit the user's default-browser association on every
supported platform, so this routes through the actual browser rather
than (e.g.) Preview.app on macOS.

## Supported MIME types

`image/png`, `image/jpeg`, `image/gif`, `image/webp`, `image/bmp`,
`image/avif`, `image/svg+xml`. MIME is determined by magic-byte sniff
first, file-extension hint second.

Anything else is rejected with a clear error rather than silently
forwarded — base64 of an unknown blob in the model's context window is
never useful.

## Limits

- Images larger than `SOFT_MAX_BYTES` (default 8 MiB) trigger a
  warning in the tool result. Inline rendering still works; the warning
  is for context-window awareness.
- `https://` fetches use the global `fetch` and respect the agent's
  abort signal.
- The custom message renderer for the slash-command path uses pi-tui's
  `Image` component with `maxWidthCells: 60`; the LLM-tool path inherits
  pi's normal tool-result image rendering.

## Settings (module constants in `index.ts`)

```
SOFT_MAX_BYTES = 8 * 1024 * 1024   // warn-only soft cap
TMP_ROOT       = $TMPDIR/pi-imgview
DEFAULT_MODE   = "terminal"
```

## Running the unit tests

```bash
cd ~/.pi/agent/extensions/imgview
npx tsx --test utils.test.ts
```

## Why this is separate from `antigravity-image-gen`

`antigravity-image-gen` *creates* images by calling Google Antigravity,
then returns them as tool-result attachments. `pi-imgview` *displays
existing images* — files on disk, things at URLs, or data URIs the model
constructs on its own. They compose: have the model generate via
antigravity, save the result to disk, then `show_image` it.

---

Share your own pi extension by publishing it to npm with the `pi-package`
keyword — pi's [package gallery](https://pi.dev/packages) auto-indexes it.

[pi]: https://github.com/badlogic/pi-mono
