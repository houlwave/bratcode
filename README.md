<div align="center">

<img src="docs/demo.gif" alt="bratcode demo" width="720">

# bratcode

**every session is an album.**

black terminal · brat green `#8ACE00` · demure pink `#F3B6D6` · zero dependencies

[![license](https://img.shields.io/badge/license-MIT-000000?style=flat-square&labelColor=8ACE00)](LICENSE)
[![node](https://img.shields.io/badge/node-%E2%89%A518-000000?style=flat-square&labelColor=8ACE00)](https://nodejs.org)
[![status](https://img.shields.io/badge/status-design%20preview-000000?style=flat-square&labelColor=8ACE00)](#status)

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

needs only **node 18+**. no `npm install`, no dependencies. the installer puts the code in `~/.bratcode` and links `bratcode` into `~/.local/bin` (and adds it to your `PATH` if needed).

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
| `esc` | stop the reply |
| `ctrl+c` | clear input, press twice to quit |
| `ctrl+n` | new session |

slash commands: `/new` `/flip` `/demo` `/help` `/clear` `/quit`

## options

```bash
bratcode --no-anim        # no animations
bratcode --version
bratcode --help
```

works in any modern terminal. if colors look off (macOS Terminal.app has no truecolor) it falls back to 256 colors automatically; force it with `BRATCODE_COLORS=256`. for the best result use iTerm2, Ghostty, WezTerm, kitty or Warp. the layout adapts: below 80 columns the cover hides and only the input stays.

## status

this is a **design preview**. the interface is finished, the agent is not connected: sending a message shows a stub reply so you can feel the whole flow. real functionality (models, files, tools) comes next.

## how it is built

zero dependencies, plain ES modules:

```
bin/bratcode.js   entry
src/app.js        screens, input, flip, tracks, player line, stub reply
src/term.js       cell buffer + diff renderer, truecolor / 256 fallback
src/cover.js      pixel font + gaussian blur drawn with half-block cells
src/keys.js       key parser (csi, alt, ctrl, bracketed paste)
src/text.js       text input buffer + wrapping
src/theme.js      colors and the two sides
scripts/          headless renderer that makes the screenshots above
```

the cover is a tiny pixel font blurred in software, then packed two pixels per terminal cell with `▀`, so the blur is smooth instead of blocky. the flip is the same picture squeezed horizontally by `|cos(πt)|`.

## license

MIT
