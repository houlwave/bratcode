<div align="center">

<img src="docs/demo.gif" alt="bratcode demo" width="720">

# bratcode

**every session is an album.**

black terminal · brat green `#8ACE00` · demure pink `#F3B6D6` · a full desktop agent

[![license](https://img.shields.io/badge/license-MIT-000000?style=flat-square&labelColor=8ACE00)](LICENSE)
[![node](https://img.shields.io/badge/node-%E2%89%A518-000000?style=flat-square&labelColor=8ACE00)](https://nodejs.org)
[![status](https://img.shields.io/badge/status-v1.0-000000?style=flat-square&labelColor=8ACE00)](#status)

</div>

---

## install

```bash
curl -fsSL https://raw.githubusercontent.com/houlwave/bratcode/main/install.sh | bash
```

then run:

```bash
bratcode
```

needs **node 18+**. the installer installs the few dependencies quietly, puts the code in `~/.bratcode` and links `bratcode` into `~/.local/bin` (and adds it to your `PATH` if needed).

update: run the same command again. uninstall:

```bash
curl -fsSL https://raw.githubusercontent.com/houlwave/bratcode/main/install.sh | bash -s -- --uninstall
```

## the idea

most coding clis are a prompt and a log. bratcode is a **record**.

| in the terminal | what it means |
| --- | --- |
| **the cover** | a square, slightly out-of-focus `brat` on green. it pulls into focus when you launch, then keeps breathing. |
| **side a / side b** | two modes. `A brat`: fast, loud, ships it (green). `B demure`: calm, very mindful, plans first (pink). |
| **`tab` flips the record** | the cover physically turns over (it narrows to an edge and opens as the other side). |
| **your messages are tracks** | `01`, `02`, `03`... each with a duration like `0:07`. the session reads like a tracklist. |
| **the bottom line is a player** | idle: a short green segment. thinking: a segment runs along the line. reply: the line fills up. |
| **equalizer instead of a spinner** | `▁▂▃▅▇` bars move while the agent works. |
| **black background, two accents** | everything is black, white and grey. green and pink appear only where something is alive: the cursor, the active side, the player. |

<table>
  <tr>
    <td><img src="docs/home.png" alt="side a"></td>
    <td><img src="docs/side-b.png" alt="side b"></td>
  </tr>
  <tr>
    <td><img src="docs/chat.png" alt="a session as a tracklist"></td>
    <td><img src="docs/demo.png" alt="a diff"></td>
  </tr>
  <tr>
    <td><img src="docs/palette.png" alt="command palette"></td>
    <td><img src="docs/intro.png" alt="intro: the cover comes into focus"></td>
  </tr>
</table>

it stays simple on purpose: one input, one line, two chips at the bottom. no menus to learn. the hint row always shows the two keys you need: `tab` and `ctrl+p`.

## keys

| key | action |
| --- | --- |
| `enter` | send |
| `alt+enter` / `ctrl+j` | new line |
| `tab` / `shift+tab` | flip the record: side a / side b |
| `ctrl+p` or `/` | command palette |
| `up` / `down` | message history |
| `pgup` / `pgdn` | scroll |
| `esc` | stop the agent |
| `ctrl+c` | clear input, press twice to quit |
| `ctrl+n` | new session |

slash commands: `/new` `/flip` `/tg` `/accounts` `/balance` `/model` `/undo` `/stop` `/demo` `/help` `/clear` `/quit`

## options

```bash
bratcode --no-anim        # no animations
bratcode --demo           # design preview, nothing is connected
bratcode --version
bratcode --help
```

env: `BRATCODE_COLORS=256`, `BRATCODE_NO_TUNNEL=1` (local sandbox only), `BRATCODE_DATA=<dir>` (state, default `~/.bratcode-data`).

works in any modern terminal. if colors look off (macOS Terminal.app has no truecolor) it falls back to 256 colors automatically; force it with `BRATCODE_COLORS=256`. for the best result use iTerm2, Ghostty, WezTerm, kitty or Warp. the layout adapts: below 80 columns the cover hides and only the input stays.

## what it does

one prompt = **one continuous request**. the model gets a private link to a small server on your mac and drives it with plain `GET` requests: read and edit files, run commands, look at pages, control macOS, use telegram. you watch every step appear under your track.

- **type while it works.** text sent during a run does not start a new request: it lands in the run's inbox and the agent reads it with its next step (`+ your text` in the log). no new limits are spent.
- **your computer is the sandbox.** files anywhere on disk, `exec`, background services, browser and vision tools, `osascript` for Calendar / Notes / Reminders / Finder / Music, screenshots, clipboard. every file change is backed up, `/undo` reverts it.
- **your telegram.** `/tg` shows a QR code in the terminal (half blocks), supports 2fa. then: "find the family chat, read the weekend plans, text mom that we are coming".
- **account pool.** accounts live in `~/.bratcode-data`. the best usable account is picked automatically; when credits run out mid-answer the next one continues in the same project, seamlessly. add accounts with `/accounts` (sign in in a window, or import read-only from Chrome / Brave / Edge).
- **live balance.** refreshed the moment you start typing a prompt, and again right after every request. the bottom line always shows it.
- **side a / side b.** `A brat` runs sensitive actions (like sending a telegram message) immediately. `B demure` plans first and asks you with a card (`enter` allow, `esc` deny).

the bottom line: `~/dir:branch · tunnel · tg · 12,340 cr`.

## status

v1.0. the tui, the sandbox, telegram and the pool are connected and covered by tests (`npm test`, mock genspark + fake telegram, no network needed). the https tunnel is a cloudflared quick tunnel that the installer downloads for you.

## how it is built

plain ES modules, a few runtime deps (`playwright-core`, `telegram`, `qrcode`):

```
bin/bratcode.js     entry (--demo = no brain)
src/app.js          screens, input, flip, tracks, live run, status line
src/brain.js        wires pool + runner + sandbox + telegram + captcha
src/overlays.js     /tg qr, /accounts, /model, approval card
src/sandbox/        the mac as a GET agent: server, files, edit, code, exec, browser, macos, undo, inbox, tunnel
src/telegram/       personal telegram (gramjs): qr login, tg_* agent commands
src/pool/           accounts, live balance, ai_chat sse runner, handoff
src/term.js         cell buffer + diff renderer, truecolor / 256 fallback
src/cover.js        pixel font + gaussian blur drawn with half-block cells
tests/              node tests/run-all.js (pool, sandbox, telegram, tui)
scripts/            headless renderer that makes the screenshots above
```

the cover is a tiny pixel font blurred in software, then packed two pixels per terminal cell with `▀`, so the blur is smooth instead of blocky. the flip is the same picture squeezed horizontally by `|cos(πt)|`.

## license

MIT
