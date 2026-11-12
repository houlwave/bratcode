// Справка агенту: компактная по умолчанию, подробности - по темам (/help?topic=...), минимум - /help?level=min.
export const TOPICS = ['files', 'edit', 'code', 'batch', 'memory', 'browser', 'emulate', 'vision', 'shell', 'mac', 'telegram', 'undo']

export function helpText(base, ROOT, { topic = '', level = '', notes = '', extra = {} } = {}) {
  const T = String(topic || '').toLowerCase().trim()
  const notesBlock = notes ? `\n## PROJECT NOTES (saved earlier with /remember - read them first)\n${notes}\n` : ''

  const head = `# Code Sandbox - agent API (GET only)

You can fully work inside this sandbox using ONLY plain GET requests (open URLs): write code, run it, AND SEE how the
page looks and clicks buttons in a real browser. No JavaScript/terminal of your own is needed.
Every command is a URL:  ${base}/<command>?<params>
Responses are plain text (add &format=json for JSON). Open the URL to "run" the command, then read the answer.
The human watches every command you run LIVE in the IDE (like a terminal log), and may send you messages: they appear
at the end of any response as ">>> NEW MESSAGE FROM THE USER" - always read and follow them.
`
  const encoding = `
## URL encoding (important)
- Percent-encode values (space=%20, newline=%0A, "+"=%2B, "&"=%26, "#"=%23, "%"=%25, "|"=%7C), text is UTF-8.
- If your tool mangles special characters, use the *_b64 variant (content_b64, cmd_b64, find_b64, replace_b64, edits_b64, patch_b64,
  js_b64, steps_b64, cmds_b64) with standard or URL-safe base64. Most reliable way to send code.
- URL/headers can be up to ~4 MB. Bigger files: first chunk without append, then repeat with &append=1 (each chunk <= 64 KB).
  Binary files: content_b64.
`
  const writing = `
## Writing files
- write?path=/a.js&content=<URL-encoded text>   or   write?path=/a.js&content_b64=<base64>   (parent dirs are created automatically)
- Overwrites the file; &append=1 appends. Empty file: touch?path=/a.txt (or write without content).
- If write answers "missing path" / "no content" the parameter did not arrive: resend it, preferably as content_b64.
`
  const files = `
## Files and shell
ls        ${base}/ls?path=/&depth=2                  list files (depth 0-4)
read      ${base}/read?path=/app/index.html          contents (&start=1&end=50 range, &numbered=1 = line numbers + file sha)
write     ${base}/write?path=/app/index.html&content=Hello    create/overwrite; &append=1 to append (see "Writing files")
          ${base}/write?path=/a.py&content_b64=cHJpbnQoMSk=   same, base64
          POST ${base}/write?path=/a.py  with the file text as the raw request body (if you can send POST) - no escaping needed
touch     ${base}/touch?path=/app/.gitkeep                     create an empty file (does not change an existing one)
edit      ${base}/edit?path=/a.py&find=foo&replace=bar        exact replace (&all=1 = every occurrence). On a miss it shows the
          closest text and how to fix the request; nothing is changed on error.
multiedit ${base}/multiedit?path=/a.py&edits_b64=<base64 of JSON [{"find":"a","replace":"b"},{"start":10,"end":12,"replace":"new"}]>
          several edits in ONE request, ALL or NOTHING.     patch  ${base}/patch?patch_b64=<unified diff or "*** Begin Patch">  (or POST it)
          After write/edit/multiedit/patch the answer ends with "SYNTAX: OK" or the exact syntax error - fix it at once. Details: /help?topic=edit
mkdir | rm | mv?from=&to= | cp?from=&to=
exec      ${base}/exec?cmd=ls%20-la&cwd=/&timeout=60  run a shell command, wait (max 300s). Output = stdout+stderr + exit code.
          For: python3, node, npm install, pip install, git, unzip, tests. stdin closed. NOT for servers - use start.
start     ${base}/start?cmd=python3%20-m%20http.server%208000&name=web&cwd=/app    background process (servers)
logs      ${base}/logs?name=web&tail=50     |  ps  |  stop?name=web
curl      ${base}/curl?port=8000&path=/   (or &url=https://...)   raw HTTP request, see status + body
download  ${base}/download?url=https://.../file.zip&path=/file.zip
say       ${base}/say?text=Now%20I%20am%20styling%20the%20buttons    short status line shown to the user in the live log

## Finding things in code (text answers, output is limited - narrow with path/glob)
grep      ${base}/grep?pattern=TODO&path=/src&glob=*.js&context=2     regex search (&fixed=1 literal, &i=1 ignore case, &files=1 names only)
glob      ${base}/glob?pattern=**/*.test.js          find files by name (&sort=mtime = newest first)
tree      ${base}/tree?path=/&depth=3                project tree (skips node_modules/.git, shows counts)
outline   ${base}/outline?path=/src/app.js           functions/classes/headings of a file with line ranges
symbols   ${base}/symbols?q=createAgent              where a function/class/const is defined      refs ${base}/refs?name=createAgent   its uses
diagnostics ${base}/diagnostics?path=/src            syntax check of .js .json .py .sh files
batch     ${base}/batch?cmds_b64=<base64 of lines "read?path=/a.js" / "grep?pattern=foo">   up to 20 commands in ONE request
memory    ${base}/remember?text=...   save a note for next time (shown at the top of this help)  |  ${base}/memory
More: /help?topic=edit | code | batch | memory | browser | emulate | vision | shell        Shortest version: /help?level=min
`
  const browserShort = `
## SEEING THE PAGE (real headless Chromium) - use this after you build any UI
look      ${base}/look?file=/calc/index.html          open a workspace HTML file and describe what it LOOKS like
          ${base}/look?port=8000&path=/   |   ${base}/look?url=https://example.com   |   ${base}/look   (re-inspect current page)
          options: &mobile=1 (iPhone 14) | &device=Pixel%207 | &dark=1 | &net=slow3g | &w=1280&h=800 | &full=1 | &brief=1
          Report: ERRORS (JS/console/404), LAYOUT CHECK (overflow, overlap, contrast, tiny text, broken images...), VISIBLE TEXT,
          FIELD VALUES, INTERACTIVE ELEMENTS with CSS selectors + positions, ASCII WIREFRAME, SCREENSHOT url. FIX what LAYOUT CHECK lists.
act       ${base}/act?steps=click:%23btn-7|click:%23btn-plus|click:%23btn-eq|text:%23display      real clicks/typing, then a short report
          steps: click: dblclick: hover: type:SEL=text keys: press:Enter wait:500 scroll:600 text:SEL eval:js viewport:390x844  (separate with | or newline)
click ?sel=  |  type ?sel=&text=  |  press ?key=  |  eval ?js=document.title  |  console  |  shot ?file=...  (returns the PNG)
responsive ${base}/responsive?file=/index.html   phone/tablet/desktop in ONE call: layout problems per size + contact sheet (&dark=both)
Typical loop: write -> look -> fix LAYOUT CHECK / ERRORS -> act (click every feature) -> look&mobile=1. Full reference: /help?topic=browser
`
  const browserFull = `
## SEEING THE PAGE - full reference (real headless Chromium)
look      ${base}/look?file=/calc/index.html          open a workspace HTML file and describe what it LOOKS like
          ${base}/look?port=8000&path=/   |   ${base}/look?url=https://example.com   |   ${base}/look   (re-inspect current page)
          options: &w=1280&h=800 (viewport; stays for next calls) | &full=1 (full-page screenshot) | &brief=1 | emulation: /help?topic=emulate
          The report contains:
            ERRORS         JavaScript exceptions, console.error, failed/404 requests
            LAYOUT CHECK   horizontal overflow, overlapping buttons, low text contrast, tiny text, broken images, empty page,
                           missing viewport meta, small touch targets
            VISIBLE TEXT, FIELD VALUES (e.g. calculator display), STYLE (colors/font)
            INTERACTIVE ELEMENTS with exact CSS selectors, positions and sizes (x,y,w,h), text/background colors
            WIREFRAME      ASCII drawing of the layout: boxes = buttons/inputs, text = headings -> you can "see" alignment
            SCREENSHOT     URL of a PNG (open it if you can view images)
          If LAYOUT CHECK lists problems - FIX them (edit the file), then /look again. Also check &mobile=1.
act       ${base}/act?steps=click:%23btn-7|click:%23btn-plus|click:%23btn-3|click:%23btn-eq|text:%23display
          Steps are separated by "|" or a newline (%0A):
            click:SELECTOR  dblclick:SELECTOR  hover:SELECTOR  type:SELECTOR=text  keys:text (type on keyboard)
            press:Enter|Backspace|Escape|Control+a  wait:500 (ms)  scroll:600  text:SELECTOR (read element text)
            eval:document.title  viewport:390x844
          SELECTOR: any CSS (#id, .class, button:nth-of-type(3)) or text=Visible Text (e.g. click:text=Save).
          For steps containing "|" use steps_b64 (newline-separated). Add &open=1 with file=/port=/url= to reload the page first.
click     ${base}/click?sel=%23btn-7        type  ${base}/type?sel=%23name&text=Bob      press ${base}/press?key=Enter
eval      ${base}/eval?js=document.title    run JavaScript on the page (js_b64 for long code)
console   ${base}/console                   new console/network messages since last time
shot      ${base}/shot?file=/calc/index.html   returns the PNG itself;  &selector=%23hero | &clip=x,y,w,h | &full=1
responsive ${base}/responsive?file=/index.html&sizes=375x667,768x1024,1280x800&dark=both
          LAYOUT CHECK per viewport size in ONE call + contact sheet; dark=both adds the dark color scheme. Use it before saying "responsive".
Typical loop: write -> look -> fix LAYOUT CHECK / ERRORS -> act (click every feature, verify FIELD VALUES) -> look&mobile=1.
`
  const emulate = `
## Device and environment emulation (for look / act / shot / responsive; standalone: ${base}/emulate?...)
${base}/look?file=/index.html&device=iPhone%2014        real phone: viewport, pixel ratio, touch, mobile user agent
${base}/devices                                          list of devices (any part of a name works: device=pixel, device=ipad%20mini)
&mobile=1 = iPhone 14       &mobile=0 / &device=desktop = back to desktop
&dark=1 | &dark=0 | &dark=auto      prefers-color-scheme (check the dark theme!)         &reduced=1   prefers-reduced-motion
&net=slow3g | 3g | 4g | offline | fast      network speed (is there a loader? does the page survive offline?)
&lang=de-DE   navigator.language + Accept-Language        &tz=Asia/Tokyo   timezone        &dpr=2   pixel ratio
&reset=1      clear ALL emulation.
Settings STAY ON for the next calls (the report prints an "EMULATION:" line). Changing device/lang/tz/dpr reopens the current page
(typed text is lost). Checklist: look&mobile=1 -> look&dark=1 -> look&net=slow3g (loading states) -> look&reset=1.
`
  const edit = `
## Editing files safely (edit / multiedit / patch)
All three are ALL-OR-NOTHING: on any problem nothing is written and the error says what to change. CRLF line endings are kept.
&dry=1 = only check, do not write.  &expect_sha=<sha from /read?numbered=1> = refuse (409) if the file changed meanwhile.

edit       ${base}/edit?path=/a.py&find=<text>&replace=<text>[&all=1]     "find" must match EXACTLY and be unique (else: lists the lines
           where it matches / shows the closest text). Add neighbouring lines to "find" to make it unique.
           by lines: ${base}/edit?path=/a.py&start=10&end=12&replace=<new text>     (replaces lines 10-12; empty replace = delete them)
multiedit  ${base}/multiedit?path=/a.py&edits_b64=<base64 of JSON>
           JSON: [{"find":"old","replace":"new"},{"find":"x","replace":"y","all":true},{"start":40,"end":44,"replace":"new lines"}]
           Edits apply in order (each sees the result of the previous one). Without base64: find1=a&replace1=b&find2=c&replace2=d
patch      ${base}/patch?patch_b64=<base64>   or POST the patch text as the body. Two formats:
           (1) unified diff (git diff / diff -u):  --- a/src/a.js / +++ b/src/a.js / @@ -3,4 +3,5 @@ ...  (also new/deleted files)
           (2) compact:   *** Begin Patch
                          *** Update File: /src/a.js
                          @@ function start()          <- optional hint: a line near the change
                           context line (starts with a space)
                          -line to remove
                          +line to add
                          *** Add File: /src/new.js    (every line starts with +)
                          *** Delete File: /src/old.js
                          *** End Patch
           Wrong line numbers / different whitespace in the context are tolerated. Several files = all changed or none. &root=/folder prefixes paths.
read       ${base}/read?path=/a.py&start=20&end=60&numbered=1     header with total lines + file sha ("N: " prefixes are not part of the file)
After every write/edit/multiedit/patch: new sha and "SYNTAX: OK" / "SYNTAX ERROR ..." (checked: .js .mjs .cjs .json .py .sh).
Tip: big change - write the whole file; 1-5 small changes - multiedit; changes in several files - patch.
`
  const code = `
## Code navigation (text answers, limited; each says how to narrow it)
tree      ${base}/tree?path=/src&depth=3[&lines=1]            folders first, node_modules/.git skipped (shows how many files are hidden)
glob      ${base}/glob?pattern=**/*.css&path=/src[&sort=mtime]  *, **, ?, {a,b}; "!x" excludes; a pattern without "/" matches the file name
grep      ${base}/grep?pattern=handle(Click|Submit)&path=/src&glob=*.js,*.jsx&context=2
          &fixed=1 (plain text) &i=1 (ignore case) &files=1 (names only) &count=1 (matches per file) &max=50 &all=1 (also node_modules)
outline   ${base}/outline?path=/src/app.js               functions/classes/methods/headings with line ranges [from-to]
          then read just that part: /read?path=/src/app.js&start=120&end=180&numbered=1
symbols   ${base}/symbols?q=render&kind=function&path=/src    definitions by name (js/ts/py/go/rs/java/c/rb/php/sh/css/md/html)
refs      ${base}/refs?name=renderTodo                    every use of an identifier: [def] [import] [use]
diagnostics ${base}/diagnostics?path=/src                 syntax errors in .js .mjs .cjs .json .py .sh (NOT types - for TypeScript: exec?cmd=npx tsc --noEmit)
Workflow for a bigger task: tree -> grep/symbols -> outline -> read (range) -> multiedit/patch -> diagnostics -> tests with exec.
`
  const batch = `
## batch - several commands in ONE request (saves round trips)
${base}/batch?cmds_b64=<base64 of the lines>      one command per line, each "command?params", e.g.
    write?path=/a.js&content_b64=...
    exec?cmd=node%20a.js
or ${base}/batch?cmds=read%3Fpath%3D/a.js%0Agrep%3Fpattern%3Dfoo      (newline = %0A; the line itself must be URL-encoded once more)
POST ${base}/batch with JSON {"cmds":[{"command":"write","path":"/a.js","content":"..."},{"command":"exec","cmd":"node a.js"}]}
Rules: max 20, run in order, stops at the first failure (&continue=1 = go on), each output is shortened (&each=12000 allows more),
no shot/batch/help inside. Every command still appears separately in the user's live log.
Good use: write 3 files + exec test; read 3 files; edit + diagnostics + look.
`
  const memory = `
## Project memory (notes that survive between your sessions in this sandbox)
${base}/remember?text=Use%20tabs%2C%20API%20is%20at%20/api/v2     save a short note (one fact per note: decisions, how to run tests, pitfalls)
${base}/memory                    show notes       ${base}/memory?forget=tabs   delete notes containing a word      ${base}/memory?clear=1   delete all
Notes are printed at the top of /help, so a new session sees them at once. Save: how to start/test, chosen stack, user preferences,
what is done / what is left. No secrets. Notes live next to the workspace (not inside the project).
`
  const vision = `
## LOOKING AT PICTURES AND VIDEO (you are NOT blind)
FIRST, once: ${base}/selftest   (checks Chromium, image lab, ffmpeg; on FAIL run the printed FIX line).
Every command returns (1) "SEE IT:" - an image URL AND a file path: if you have ANY image-viewing tool (read image by path/URL),
OPEN IT - that is real sight, always prefer it; (2) an exact TEXT description for when you cannot open images.
view      ${base}/view?file=/refs/house.png      size, PALETTE, SHAPES (x,y,w,h, fill: ~1.0 rectangle, ~0.79 ellipse, ~0.5 triangle + apex UP/DOWN), TEXT MAP
          &crop=x,y,w,h (source px or 10%25,20%25,50%25,40%25) zoom | &grid=50 labeled coordinates | &ocr=1 read text | file= path | url= | screenshot name s123.png
tiles     ${base}/tiles?file=/refs/scene.png&cols=2&rows=2     big/detailed picture cut into pieces at native size (small details, HUD, text, windows)
          &tile=r1c2 one piece | &cols=4&rows=3 finer. Then open each piece. Use it BEFORE judging details.
compare   ${base}/compare?a=/refs/house.png&b=/out/mine.png    SAME framing: VERDICT, % different, DIFF GRID, WHERE they differ (x,y,w,h, colors), A|B|DIFF + overlay
          &mode=side|overlay|diff|all  &crop=x,y,w,h  &thr=24 | b can be a screenshot of your page: /shot or /look, then b=s123.png
          &mode=style  DIFFERENT camera angle/size/scene (pixel diff is meaningless): brightness, contrast, palette, hue, detail density,
          light/detail layout grids, edge maps, SUMMARY of what to fix first. It says HOW MUCH differs; WHAT differs - read by opening the pictures.
sheet     ${base}/sheet?dir=/refs  |  ?files=/a.png|/b.png      contact sheet + dominant colors + change between neighbours
frames    ${base}/frames?file=/refs/trailer.mp4&n=8&from=2&to=5   video/GIF frames as a sheet + per-frame files; high "change" = cut or fast motion
shot      ${base}/shot?file=/out/index.html&selector=%23hero | &clip=x,y,w,h | &full=1     PNG of an element / region / whole page
Loop: build -> /shot or /look -> open the picture -> /compare (same framing) or /compare&mode=style (other angle) -> /tiles for details -> fix the biggest
difference -> repeat. Never say "I cannot see the image": open "SEE IT", or read the text report. TIMEOUT / "Chromium ... FIX:" = it self-heals, run /selftest.
`
  const mac = `
## macOS control (the user's real Mac)
sysinfo    ${base}/sysinfo                                     OS, CPU, RAM, battery, disk, frontmost app, cwd
osascript  ${base}/osascript?script_b64=<base64 AppleScript>   (or &script=..., &lang=js for JavaScript for Automation)
           Calendar / Notes / Reminders / Finder / Music / Messages / Mail / Safari are scriptable. Examples:
           tell application "Reminders" to make new reminder with properties {name:"Buy milk"}
           tell application "Calendar" to get summary of every event whose start date > (current date)
           tell application "Music" to playpause
screen     ${base}/screen[?display=1]                          screenshot of the whole screen; the answer has a SEE IT link + description
clipboard  ${base}/clipboard                                   read it;  ${base}/clipboard?text=hello   write it
open_app   ${base}/open_app?name=Safari[&url=https://...]      launch an app (optionally open a url/file with it)
open       ${base}/open?target=~/Desktop/a.pdf                 open a file/url with the default app
notify     ${base}/notify?title=Done&text=Build%20finished     macOS notification
`
  const telegram = `
## Telegram (the user's PERSONAL account, via MTProto)
tg_status  ${base}/tg_status                                   is it linked, whose account
tg_dialogs ${base}/tg_dialogs?limit=30[&unread=1]              chats with ids, unread counts, last message
tg_search  ${base}/tg_search?q=Мама                            find contacts/chats by name, @username or phone
tg_read    ${base}/tg_read?chat=<id|@user|name>&limit=40       history with author, date + weekday, replies   (&offset_id=, &search=)
tg_find_msg ${base}/tg_find_msg?q=выходные[&chat=<id>]         search messages by keywords in all chats or in one
tg_send    ${base}/tg_send?chat=<id|@user|name>&text=Привет    send AS THE USER (text_b64 supported). In demure mode the user confirms it first.
Typical flow: tg_search?q=Семья -> tg_read?chat=<id> -> summarize plans. For "write to mom": tg_search?q=Мама -> tg_send.
If tg_status says not linked: tell the user to run /tg in bratcode. Never invent chat ids - take them from tg_search / tg_dialogs.
`
  const undo = `
## Undo
Before write/edit/multiedit/patch/rm/mv/cp/download the previous state is backed up.
history ${base}/history[?n=20]     list of backed-up changes (newest first)
undo    ${base}/undo[?n=1]         revert the last n changes (files created by the agent are deleted, overwritten ones restored)
`
  const attach = `
## User attachments
Files the user attached to the chat are copied to the sandbox into the folder /_attachments/<session>/ (see the task text for the
exact paths). Pictures: /view and /compare them. Video: /frames. Text/code/zip: read, unzip with exec. Do not delete them.
`
  const share = `
## Sharing results with the user
files     ${base}/files/app/index.html    static site preview (relative links work) - give THIS link to the user
site      ${base}/proxy/8000/             live server started with "start" on that port - give THIS link to the user
`
  const HOST = !!extra.cwd
  const notesSec = HOST ? `
## Notes (this is the user's REAL computer: ${extra.platform === 'darwin' ? 'macOS' : extra.platform})
- You work on the user's own machine. Paths are REAL: absolute (/Users/me/Desktop/a.txt), ~/Downloads/x.zip, or relative to the project folder ${extra.cwd}.
- Default folder (when path/cwd is omitted): ${extra.cwd}. The whole disk is reachable. Be careful with destructive commands.
- Every file change is backed up automatically: ${base}/undo reverts the last one, ${base}/history lists them.
- Use ports 8000-8999 for dev servers you start. The user watches every step live in bratcode and can send you messages (they arrive at the end of any answer).` : `
## Notes
- Workspace root "/" is the real folder ${ROOT}. All paths are relative to it. Use ports 8000-8999 (3000 is the IDE).
- Keep everything of the task inside the project folder given in the task (paths like /<folder>/file); run commands with cwd=/<folder>.
- The user sees your files appear in the IDE file tree and every command in the live "Agent" log.
- Verify everything: run it, test it, look at it, fix errors, repeat. Do not claim "works" without checking.
`
  const min = `# Code Sandbox - agent API (GET only) - SHORT VERSION
Every command is a URL:  ${base}/<command>?<params>   Plain-text answers. Send code as *_b64 (base64) if special characters break.
The user watches the log live; messages from the user appear at the end of answers (">>> NEW MESSAGE FROM THE USER") - follow them.

write    ${base}/write?path=/app/index.html&content_b64=<base64>        (dirs are created; &append=1)
read     ${base}/read?path=/app/index.html&numbered=1                   (&start=1&end=50)
edit     ${base}/edit?path=/app/a.js&find=<old text>&replace=<new text>  (exact, unique; &all=1)
multiedit ${base}/multiedit?path=/a.js&edits_b64=<base64 of [{"find":"a","replace":"b"}]>     patch  ${base}/patch?patch_b64=<diff>
exec     ${base}/exec?cmd=node%20a.js&cwd=/app&timeout=60               run a command, see output + exit code
start    ${base}/start?cmd=python3%20-m%20http.server%208000&name=web   server in background (use ports 8000-8999)
ls / tree / grep?pattern=TEXT / glob?pattern=**/*.js / outline?path=/a.js          look around in the project
look     ${base}/look?file=/app/index.html      see the page: ERRORS, LAYOUT CHECK (fix what it lists), text, buttons + selectors, screenshot
act      ${base}/act?steps=click:%23btn|text:%23out                      click through the page like a user
view     ${base}/view?file=/ref.png    look at a picture (open the "SEE IT" link/file if you can; the text report describes it too)
files    ${base}/files/app/index.html   link for the user       site ${base}/proxy/8000/   link to a running server
remember ${base}/remember?text=...      save a note for next time
Loop: write -> look -> fix problems -> act -> look&mobile=1. Check everything before saying "done".
More: ${base}/help?topic=edit | code | batch | memory | browser | emulate | vision | shell   Full list: ${base}/help
`
  const lvl = String(level || '').toLowerCase()
  if (T === 'all' || T === 'full' || lvl === 'max' || lvl === 'full') return head + notesBlock + encoding + writing + files + edit + code + batch + memory + browserFull + emulate + vision + (extra.cwd ? mac + telegram + undo : '') + attach + share + notesSec
  if (T) {
    const page = { mac, telegram, undo, files, shell: files, edit, code, batch, memory, browser: browserFull, emulate, vision, look: browserFull, attachments: attach }[T]
    if (!page) return `Unknown help topic "${T}". Topics: ${TOPICS.join(' | ')}   (${base}/help?topic=<name>)   Short: ${base}/help?level=min   Everything: ${base}/help?topic=all`
    return `# Help: ${T}\n` + page + `\nBack to the overview: ${base}/help   |   topics: ${TOPICS.join(', ')}\n`
  }
  if (lvl === 'min' || lvl === 'short' || lvl === 'low' || lvl === '1') return min + (notes ? `\nPROJECT NOTES (from /remember):\n${notes}\n` : '')
  return head + notesBlock + encoding + writing + files + browserShort + vision + (extra.cwd ? mac + (extra.telegram === false ? '' : telegram) + undo : '') + attach + (extra.cwd ? '' : share) + notesSec
}
