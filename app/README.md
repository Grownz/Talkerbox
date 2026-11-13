# Talkerbox (desktop app): developer documentation

Technical reference for the app in this folder: how each feature works, data formats, runtimes and checks. For what
the app does from a user's point of view, installation and the step-by-step build guide, see the
[top-level README](../README.md); for the release history, [CHANGELOG.md](../CHANGELOG.md).

Tauri v2 (Rust backend in `src-tauri/`), Svelte 5 + TypeScript frontend in `src/`, Vite, unit tests in `tests/`.
The LLM comes from a locally installed [Ollama](https://ollama.com), which Talkerbox never installs. Speech comes from the
separate TTS sidecar in `../tts-sidecar` (Kokoro ONNX).

## Features in detail

- **Ollama discovery**: checks `http://127.0.0.1:11434/api/version` first, then looks for `ollama.exe` at the saved
  path, on `PATH`, in `%LOCALAPPDATA%\Programs\Ollama`, and in `C:\Program Files\Ollama`. If none is found, a dialog asks
  for the folder or exe. The path is checked and then saved.
- **Start/stop `ollama serve`**: click the status light in the sidebar or on the Server page (its tooltip says what a click does). Only a server
  that Talkerbox started can be stopped. When the window closes, that server is killed together with its runner
  processes. Spawned processes are also placed in a Windows job object with kill-on-close, so they die even if
  Talkerbox crashes or is killed.
- **Auto-start**: when the app opens and Ollama was found but is not running, Talkerbox starts `ollama serve` right
  away (once; a failure shows the usual error banner). If Ollama is not found, the path dialog opens instead. The
  "Start Ollama automatically" switch on the Server page turns this off (setting `ollamaAutostart`, default on).
- **Layout**: a left sidebar with Chat, Models, Speech, Avatar and Server pages and the Ollama status at the bottom. Below
  1024 px window width it collapses to a 64 px icon rail. Toolbar buttons shorten their labels, then become icons
  (tooltip and accessible name stay) when space runs out; text inputs shrink first. The window cannot be made smaller
  than 720 x 520.
- **Light/dark mode**: follows the Windows setting by default. The sun/moon switch at the bottom of the sidebar
  overrides it; the choice is kept in the webview's localStorage.
- **Chat**: streamed replies (`/api/chat`), model picker (`/api/tags`), history kept in memory, stop button.
- **Models**: pull from a HuggingFace link, `hf.co/user/repo[:quant]` or a library name (`/api/pull`, with progress).
  You can also import a `.gguf` from any direct URL: it downloads with resume, is uploaded through `/api/blobs`, and is
  imported through `/api/create` with `files`. The file goes to `gguf\<first 16 hex chars of sha256(url)>\`. A retry
  after a failed import reuses the finished file, and the folder is deleted once Ollama has imported it. Every
  download's partial file is named `<file>.<url hash>.part`, so a resume never mixes data from two URLs. The view
  lists and deletes models and downloads the TTS model files.
- **Short display names**: `hf.co/owner/Repo-GGUF:Q4_K_M` is shown as `Repo Q4_K_M`. GGUF imports from HuggingFace use
  the repo id from the HF API plus the quant parsed from the file name. Other hosts use the file name without its
  extension, cut to 50 characters. Names are stored in settings, keyed by the Ollama id; the id itself never changes.
  For non-HF hosts the page title is not fetched: a direct `.gguf` link has no HTML page, and requesting it would
  download the model.
- **TTS**: the "Speak replies" checkbox starts the sidecar right away. If the start fails, the box unchecks itself and
  the reason is shown. Unchecking stops the sidecar and all speech at once. With the setting on, TTS starts
  automatically when the app opens. Replies are spoken sentence by sentence (queued, played with WebAudio). There is a
  stop button and a speed slider. Each finished assistant reply gets a green play button that re-reads it from the
  start and cancels any current speech. Sentences also end at CJK `。！？`, and any piece over 1500 characters is cut
  at the last space or comma (the sidecar rejects texts over 2000). TTS start, stop and restart run one at a time.
  Stopping closes the sidecar's stdin and waits up to 3 s before killing it: only a clean exit lets the PyInstaller
  exe delete its `%TEMP%\_MEI*` folder. App exit uses the same path, and the job object stays as a safety net.
- **Avatar window**: the "Avatar" button in the chat header or the switch on the Avatar page opens a second window
  (`puppet.html`, label `puppet`) with the selected character (or the built-in demo figure) whose mouth follows the
  loudness of the spoken reply. For every sentence the main window sends one `avatar://sentence` event with a 20 ms
  loudness envelope and the playback start time on the shared clock; the avatar window plays it on its own animation
  loop. The event also carries the mouth shape per 20 ms (viseme lip-sync, `src/lib/viseme.ts`): a small acoustic
  classifier on the decoded sentence audio (no model, no extra dependency) looks at where the voiced energy sits after
  pre-emphasis. Energy pulled up to 1.7 kHz and more reads as wide (E, I), a low first formant without it as round
  (O, U, W), a high first formant as open (A), and hiss above 3.5 kHz as teeth (F, V, S), which closes the mouth a
  little. Loudness sets how far the mouth opens, the shape how; the shape eases over about 70 ms so neighbouring
  sounds blend, silence is neutral, and without shape data (older senders) the mouth follows the loudness only. The
  sentence's `source` (`chat` or `test`) keeps the two speakers apart: stopping "Test speech" never clears the mouth
  of a reply being read, and the other way round. Kokoro phoneme timing was checked and not used: the base model
  `kokoro-v1.0.onnx` has no duration output (only some pack exports have one), so it would not work for the default
  voices. `src/lib/poseGen.ts` turns this into a pose every frame: the mouth opens with the smoothed loudness,
  the eyes blink at random every 2 to 6 seconds, the figure sways a little, and while it speaks the arms gesture with
  a slow noisy swing whose size follows the speech energy (each limb with its own rhythm, hands follow their arm, legs
  only shift the weight a little), easing back to rest when it is quiet. With Windows "reduce motion" there is no sway
  and no gesture; mouth and blinking still work. Characters are drawn on a canvas with the part editor's renderer
  (`src/lib/rigPuppet.ts`, `src/lib/rigRender.ts`), fitted into the window, sharp on high-DPI screens; the cut-out
  and part textures are prepared once per load, so each frame only moves them, and drawing pauses while the window is
  hidden or minimised (the Rust side reports minimising with `avatar://minimized`, because WebView2 keeps running a
  minimised webview). Only the parts a character has move: without parts the whole figure sways and bobs with the speech; if the
  image or `rig.json` cannot be loaded, the demo figure is shown. "Test speech" on the Avatar page opens the avatar
  window and speaks a sample sentence with the selected voice (without running speech it plays a silent loudness
  pattern), so you can watch the avatar without chatting. Background: theme, green screen (#00ff00) or transparent
  (only the cut-out and its parts are drawn), plus an opacity slider; switching to or from transparent reopens the
  window. Position and size are saved when the window closes; if that place is on a monitor that is gone, the window
  opens on the primary monitor. Closing the main window closes the avatar window too.
- **Characters** (Avatar page, below the avatar options): "Import image…" copies a PNG, JPEG or WebP (max 20 MB and
  8192 px per side, type checked by its header bytes; JPEG photos turned by their EXIF orientation are sized upright)
  into `avatars\<id>\image.<ext>` and creates
  `avatars\<id>\rig.json`. The id is generated from the file name (`[a-z0-9-]`, `-2`, `-3`, … on collision). The list
  shows a thumbnail (the cut-out once a mask exists), the kind (portrait, or full body once arm or leg parts exist)
  and the size. You can rename a character in place, delete it (with confirmation) and pick which one the avatar
  window shows (`avatarActive`; the demo figure is the fallback). Without a mask the avatar window shows the whole
  image. `rig.json` (format `version: 1`, see `src/lib/rig.ts` and `src-tauri/src/rig.rs`) holds the image size,
  the outline mask and the parts as polygons with pivots in image coordinates from 0 to 1. It is validated on every
  load and save (number ranges, point and part counts, unique ids, parent chains, file name) and written atomically.
- **Mask editor** ("Edit mask" on a character, `src/lib/MaskEditor.svelte`, geometry in `src/lib/maskGeometry.ts`):
  outline the figure so the avatar window shows a cut-out (it renders the image clipped to the outline, which makes
  green-screen and transparent mode useful). Tools: **Polygon** (click to add points; click the first point,
  double-click or press Enter to close; drag a point to move it, click an edge to insert one, right-click or Delete
  removes one, Backspace removes the last point while drawing; arrow keys nudge the selected point), **Brush** (paint,
  or remove with Erase; `[` and `]` change the size) and **Magic wand** (adds a region of similar colour within the
  tolerance; with Erase it removes it). Brush and wand work on a working copy with a long side of 512 px; the result
  is traced back into an outline (largest area only, holes ignored) and simplified. **Smooth** (Chaikin corner cutting
  plus Douglas-Peucker) and **Snap to contour** (moves the outline along its normals onto the strongest Sobel edge
  within up to 16 working pixels, with the movement smoothed along the outline) are non-destructive: the drawn
  outline is kept in `mask.points`, the slider values in `mask.smooth`/`mask.snap` (0..1) and the result in
  `mask.smoothed` (at most 4096 points), which is what the avatar window uses. Apply makes the result the drawn
  outline. Zoom with the wheel, pinch, `+`/`-` or the buttons, `0` fits the image; pan with Space+drag, the middle
  mouse button, two fingers or the arrow keys. The Preview menu shows the cut-out on a checkerboard, green or dark
  background. Ctrl+Z / Ctrl+Y undo and redo, Ctrl+S saves, Esc closes (asking before discarding unsaved changes),
  Revert reloads the saved mask. An open avatar window reloads the character after saving.
  - **Smart select** (`src/lib/smartSelect.ts`, `src/lib/smartSession.svelte.ts`, `src-tauri/src/sam.rs`): click the figure and MobileSAM proposes its
    outline as a green overlay. Left click adds a point on the figure, right-click or Alt+click a background point,
    a drag draws a box around the figure (the last box counts); each change updates the proposal (decoder only).
    "Add" or Enter merges the proposal into the mask, with Erase on "Remove" cuts it out; the result goes through
    the same tracing (largest area), simplification, Smooth/Snap sliders and undo as brush and wand. Backspace,
    Ctrl+Z or Undo remove the last point while points are set, Esc or "Clear points" removes them all. The image is
    encoded once when the tool is first picked (long side 1024 px; the backend keeps the embedding for that
    character), so each click only runs the small decoder, whose mask comes back at the 512 px working size.
    Measured on a Ryzen 7 7700X (8 cores): model load about 0.3 s, encoder about 0.25 s (0.53 s with 2 threads),
    decoder about 20 ms per click (33 ms with 2 threads); a typical laptop CPU should stay well under 1 s for the
    encoder and under 100 ms per click. The first use offers a one-time download of about 60 MB into `sam\` (see
    "Smart select runtime"); the model memory is freed whenever the editor closes, so the next character (or the same
    one again) loads it afresh. The trash button in the Smart select bar, or "Remove model…" in the "Smart select
    model" card on the Avatar page (which shows the size on disk), deletes the downloaded files after a confirmation;
    smart select then offers the download again.
- **Part editor** ("Edit parts" on a character, `src/lib/PartEditor.svelte`; rendering in `src/lib/rigRender.ts`):
  marks the parts that move. Choose a role and press Add, then outline the part with the same polygon interactions
  and viewing controls as the mask editor. Or press **Pick** to let Smart select outline it: click the part on the
  image (right-click or Alt+click marks what does not belong to it, a drag draws a box), watch the proposal in the
  role's colour, and press Create or Enter (Esc cancels, Backspace or Ctrl+Z removes the last point). The proposal is
  traced and simplified like the mask tools (largest area, at most 1024 points), becomes a closed part with the
  role's default pivot and parent (a hand hangs on the arm of its side), and can be undone like any edit; after a
  mouth, the editor offers "Auto-split lips". It uses the same model, download, removal and per-editor release as the
  mask editor (shared code: `src/lib/smartSession.svelte.ts`, `src/lib/SmartSelectBar.svelte`). Checked with the real
  model on a synthetic figure (one click each): eye, mouth and arm outlines overlap the drawn shapes by 0.89, 0.91 and
  0.92 IoU at the 512 px working size, with the pivots at the eye centre and the arm's top end. **Face** opens "Detect
  eyes and mouth" (`src/lib/FacePanel.svelte`, see "Face detection runtime"): the backend returns 478 MediaPipe
  landmarks and `src/lib/faceParts.ts` (pure, tested) turns them into the eye contours (16 points each), the outer lip
  contour as the mouth, both lips (outer arc plus the midline between the inner lip contours, so an open mouth in the
  picture is split between them and together they cover the mouth) and the corners (landmarks 61 and 291). The parts
  are added in one undo step with the default pivots and sampled eyelid colours; roles that already have a part keep
  it (the note says which), and the note offers Undo while the detection is still the last step. Made for photos and
  realistic paintings; see the runtime section for how it does on drawings. Roles: left/right eye, mouth, left/right arm, hand and leg (the
  character's own sides), head, body, each at most once, and any number of custom parts. Arm or leg parts make the
  character a full body figure, otherwise it is a portrait (shown as a badge). When an outline is closed it gets a
  pivot, the point it turns about, shown as a crosshair you can drag: arms, hands and legs start at the middle of their
  top end (shoulder, wrist, hip), the others at their centre. "Attached to" makes a part move with another one (a new
  hand is attached to the arm of its side); loops are not offered and are refused on save. The list sets the drawing
  order (later parts are drawn in front), and each part can be renamed, deleted or hidden on the canvas. Eyes blink
  by squashing toward their pivot line over an eyelid colour, sampled from the image around the eye (pickable). The
  mouth opens by filling an optional "Open shape" (the dark inside, drawn within the mouth) in a pickable colour,
  scaled vertically with the opening (and a little wider or narrower with the mouth shape); without it a shrunk copy
  of the mouth outline is used. **Lips** (optional, on the mouth): "Upper lip" and "Lower lip" outline each lip like
  any polygon, or "Auto-split" suggests both from the mouth outline (split along the line between its leftmost and
  rightmost point, which become the mouth corners). With both lips the mouth opens by moving them apart: the upper lip
  a little up, the lower lip further down, most in the middle and not at the corners; a wide shape pulls the corners
  out and opens less high, a round one pulls them in and pushes the lips apart. The opening between them is filled
  with the inside colour, and the face around the mouth is warped so cheeks and chin follow (`src/lib/mouthWarp.ts`,
  pure and tested): a mesh in the mouth's own frame (rows follow the line where the lips meet, so only triangles
  inside the opening are torn) whose displacement falls off smoothly to zero at a radius of about 1.5 mouth widths at
  the default "Face warp" of 60 % (0 % moves only the lips, 100 % about 2.4 widths). Each triangle is drawn with a
  canvas clip and affine transform from textures cut once per character (no WebGL); triangles overlap by under one
  device pixel and the base image is cut out slightly smaller than the never-moving mesh outline, so no seams show.
  Lips outlined the wrong way round are swapped; the editor warns when a lip reaches outside the mask or the lips are
  too small to move (the mouth then opens with the open shape). Each triangle only blits the texture pixels under it.
  The preview has a Viseme menu and the Face warp slider, and Play demo cycles the mouth shapes. The preview (Preview
  menu) draws the character with the shared renderer: the base image within the mask, then each part cut from the
  image (part outline within the mask) and turned about its pivot, hands following their arm; sliders set mouth,
  blink and each arm or leg angle (-60 to 60 degrees), Play demo animates them. **Under moved parts** (per character,
  `rig.fill.mode`, `src/lib/fillUnder.ts`): arms, legs and everything attached to them (hands) move, so their
  polygons (union, grown by 2 px for the anti-aliased edge; independent of the angle, since the swept area outside the
  polygon is always covered by the moved part) are the area the base layer must not show as it is. Eyes and mouth do
  not move and are untouched. `none` keeps the original pixels (as before), `transparent` cuts the area out,
  `classic` fills it by push-pull pyramid interpolation of premultiplied RGBA (pixels outside the mask count as
  transparent, so a hole at the outline fades out instead of smearing the old background in; smooth, no texture),
  `ai` lays the stored LaMa colours over that classic fill (keeping its alpha). The base layer is computed once per
  load into a cached texture (`baseLayer` in `rigRender.ts`; at most 2048 px on the long side, so full-size images in
  the editor preview use a downscaled base): 1024 px synthetic figure about 45 ms (classic) / 22 ms (transparent),
  2048 px about 240 ms, in the WebView on a Ryzen 7 7700X. Per frame nothing is added except that moving parts are
  drawn at rest too (the base no longer shows them): one more blit per moving part. "Generate with AI"
  (`src/lib/aiFill.ts`, `AiFillPanel.svelte`) crops a square around the area (plus half its size of context),
  scales it to 512 px, masks the parts (grown by 4 px) and runs LaMa (see "AI fill runtime"); the result is stored
  as `fill.png` with `fill.rect` (the image area it covers) and `fill.sig` (signature of the moving polygons: when the
  parts change, the editor asks to generate again; until then the stored colours are used where they still apply
  and the classic fill elsewhere). `fill.png` is written only on Save (`avatar_save_fill`, PNG checked, atomic),
  deleted when a saved rig no longer references it, and goes with the character folder on delete. Data: `parts[].pivot`, `parent`, `z`, optional `label` and
  `lid`, plus `mouth.interior`, `mouth.color`, and `mouth.lipUpper`/`mouth.lipLower` (both or neither),
  `mouth.corners` (two points), `mouth.warp` (0..1) and `fill` (`mode`, optional `image`/`rect`/`sig`) (format stays
  `version: 1`, older files load unchanged). Undo, redo,
  Ctrl+S, Esc and Revert work as in the mask editor. The avatar window animates the saved parts (see Avatar window).
- **Extra voices**: on the Speech page, "Add model or voice from link" accepts a HuggingFace link (`/blob/` pages are turned into
  `/resolve/` links) or any direct URL to a `.pt`/`.npy`/`.npz`/`.bin` file of at most 50 MB. Files are stored in
  `tts\voices` in the local app data dir. The sidecar gets `--voices-dir` when that folder holds a voice file, and a
  running sidecar is restarted after a voice is added or deleted. The voice id is the file stem, so a link whose stem
  is not `[A-Za-z0-9_-]{1,64}` is rejected before downloading. After a pack is installed or changed, the app checks
  that the restarted sidecar lists the pack. If it does not, an error points to `logs\sidecar.log`; the files stay
  installed.
- **Language packs** (Kokoro fine-tunes for other languages): "Add model or voice from link…" picks the action from
  the file extension. Voice files are installed as above. An `.onnx` link opens a "New language pack" dialog with these
  fields:
  - pack name (suggested from the repo or file name)
  - espeak-ng language code (dropdown of common codes, free text allowed; suggested from HuggingFace repo tags
    within 5 s)
  - optional vocab JSON link
  - voice links, one per line

  Everything goes into `tts\packs\<id>\` (model max 1 GB, voices max 50 MB). `pack.json` is written last, so the
  sidecar never sees a half-installed pack, and a failed or cancelled install removes the folder. The id is a slug of
  the name with `-2`, `-3`, … added on collision. Installed packs are listed with their flag and voices, with "Add voice
  to this pack" and "Delete pack". `.pth`, `.safetensors` and `.ckpt` links are rejected: only ONNX fine-tunes are
  supported, with no conversion. The sidecar gets `--packs-dir` when at least one pack is installed and is restarted
  after every pack change.
- **Featured language packs** (`src-tauri/src/featured.rs`): one-click installs of two German Kokoro fine-tunes, both
  Apache-2.0. They install through the same pack mechanism, so they behave exactly like user-made packs.
  - **Martin (male)**, from `Godelaune/Kokoro-82M-ONNX-German-Martin`: the `kokoro-martin.onnx` model and
    `voices-martin.npz` (voice `martin`).
  - **Kerstin (female)**, from `crane-local-ai/Kokoro-82M-v1.0-German-ONNX`: the `onnx/model.onnx` model and
    `voices/df_kerstin.bin` (voice `df_kerstin`).

  File URLs and exact sizes come from the HuggingFace file trees, and every download must match its size. Kerstin's
  voice is headerless float32 (510x1x256), so the installer wraps it in an NPY header as `df_kerstin.npy`; the sidecar
  is unchanged. Her `tokenizer.json` vocab is kokoro-onnx's built-in vocab plus the `$` pad token at id 0, and every
  espeak-ng `de` phoneme of a test sentence is in it, so no vocab file is installed.
- **Fallback hint**: a voice without a pack whose language is unknown is spoken with the base model. When the sidecar
  reports this (`details[].fallback` from `/voices`, or `X-TTS-Fallback: 1` on a synthesize response), a single hint
  appears under the chat toolbar while that voice is selected. `tts_synthesize` passes the header to the webview as a
  leading flag byte before the WAV.
- **Ollama terminal**: the Log button under the status light (or Open log on the Server page) opens a read-only view of the stdout/stderr of the
  `ollama serve` that Talkerbox started. It keeps a ring buffer of the last 5000 lines and receives new lines through
  `ollama-log` events. It scrolls automatically and pauses while you are scrolled up; Clear empties it. Output of an
  externally started Ollama cannot be captured, and the view says so.
- **Tokens/s**: shown at the bottom-right of each reply. While streaming it is a 3-second rolling estimate from chunk
  timestamps, measured from the first token and updated once per second. When the reply is done it shows the exact
  figure from Ollama's `eval_count / eval_duration`. The rate logic is in `src/lib/rate.ts` (tested).
- **Voice picker**: a custom accessible listbox (arrow keys, Home/End, Enter, Escape) grouped by language, with
  bundled SVG flags from [flag-icons](https://github.com/lipis/flag-icons) (MIT). A native `<select>` cannot show
  images, and Windows has no flag emoji. Voice labels look like "Heart (female)", with the raw id as tooltip. The
  language mapping lives in `src/lib/voices.ts` (Kokoro prefix letters a/b/e/f/h/i/j/p/z per Kokoro-82M VOICES.md).
  Unknown prefixes get a globe.
- **Speech input** (`src-tauri/src/stt.rs`, offline, in-process): the microphone button in the composer starts and
  stops listening (red while listening). Audio from the chosen recording device is captured with `cpal`, downmixed
  to mono, resampled to 16 kHz (box-filter averaging) and fed to Vosk in 100 ms chunks on its own thread, off the
  async runtime. The live transcript fills the composer (italic, read-only, red frame) through `stt://partial` and
  `stt://final` events; text typed before stays in front of it. When the transcript is non-empty and has not changed
  for the "send after silence" time (default 5 s, setting `sttIdleSecs`), Rust emits `stt://send`, stops listening
  and the text is sent like a typed message. While listening, Send (or Enter) sends at once, Discard drops the
  dictated text, and the mic button stops and leaves the text for editing. Starting to listen stops any speech
  playback so the microphone does not hear the reply; listening while a reply is generated is allowed (the text then
  waits in the composer). Errors (no microphone, access blocked by Windows privacy settings, device unplugged) are
  shown in the chat (`stt://error`). Audio is never written to disk or sent anywhere. Listening stops on app exit.
  - **Microphone menu**: right-click the mic button (or focus it and press Shift+F10 or the Menu key) to pick the
    input device from the list `cpal` reports (`stt_devices`; the Windows default is marked). The name is saved as
    `sttDevice`; "Windows default" clears it. If the saved device is missing, the default device is used and a hint
    is shown. A choice made while listening applies from the next listening session.
  - **Continuous listening**: hold the mic button (mouse, or Space/Enter while it has focus) for 5 s. A line runs
    around the button border meanwhile, and the status line says "Hold to keep listening" for screen readers; a
    shorter press is a normal click. Then the button turns blue with an infinity badge and listening goes on after
    every send: Rust sends on the usual idle timeout, or earlier once the transcript has 100 words and reaches a
    sentence end (`.!?` or `。！？`, or the end of a Vosk utterance, since the small models emit no punctuation;
    `stt::long_enough`, tested), then resets the recognizer and starts a fresh transcript. Text that arrives while a
    reply is still generating is queued and sent when it is done. Pressing the mic button again stops.
  - **No self-listening**: while a reply is read aloud (sentences queued, synthesising or playing), speech input
    drops the microphone audio (`stt_mute`) and resumes when speech is over.
  The Speech page's "Speech input" section picks the language (`sttLanguage`: German or English) and downloads the
  Vosk small models on demand from alphacephei.com (`vosk-model-small-de-0.15`, `vosk-model-small-en-us-0.15`, about
  45 MB each). The zip is downloaded with resume (max 150 MB), unpacked to a temp folder (entries escaping it are
  rejected, max 500 MB unpacked), checked for `am/final.mdl` and moved to `stt\<model>`. If the model for the chosen
  language is missing, the mic button shows a hint instead of starting. Each installed model shows its size on disk
  and a trash button: after a confirmation that names the re-download size, `stt_remove_model` deletes it. The
  language must be one of the two known models (the folder name never comes from the page), removal is refused while
  speech input is listening with that model, and the folder is first renamed to `stt\.remove-<model>`, so a file held
  open elsewhere fails the rename and leaves the model intact; a leftover is deleted on the next status refresh.
- **Settings** (`settings.json` in the app config dir, `%APPDATA%\com.talkerbox.app`): Ollama path, last model, voice,
  TTS on/off and speed, speech input language, idle time and microphone, Ollama auto-start, avatar background,
  opacity, window bounds and selected character.

Downloads, logs and models are stored in the local app data dir (`%LOCALAPPDATA%\com.talkerbox.app`): `gguf\` (temporary),
`tts\`, `stt\` (speech input models, removable on the Speech page), `sam\` (smart select: `onnxruntime.dll` and the two MobileSAM `.onnx` files, about 64 MB;
removable on the Avatar page), `inpaint\` (the LaMa model for the AI fill, about 93 MB; removable in the part editor),
`face\` (the two MediaPipe face models, about 5 MB; removable in the part editor),
`avatars\` (each character's `rig.json`, image and optional `fill.png`) and `logs\sidecar.log`. Ollama's output is not written to disk: it is kept in memory for the terminal view.

## Prerequisites, development and release build

Prerequisites with versions, the one-time sidecar and Vosk steps, and troubleshooting are in the
[top-level README](../README.md#build-from-source). Short form, from this folder:

```powershell
npm ci
npm run tauri dev      # Vite dev server on :1420 + Rust app with hot reload
npm run tauri build    # NSIS installer: src-tauri/target/release/bundle/nsis/Talkerbox_<version>_x64-setup.exe
```

Checks:

```powershell
npm run check                          # svelte-check + tsc
npm test                               # frontend unit tests (node --test: geometry, rig, lip-sync, smart select, ...)
npm run build                          # frontend production build
cd src-tauri; cargo clippy --all-targets; cargo test   # Rust lints (warning-free) and unit tests
```

Version numbers live in `package.json`, `package-lock.json`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml` and
the `talkerbox` entry of `src-tauri/Cargo.lock`; a release bumps all five.

## TTS sidecar

The sidecar is bundled as a Tauri `externalBin` (`binaries/tts-sidecar`). Tauri expects this file:

```
app/src-tauri/binaries/tts-sidecar-x86_64-pc-windows-msvc.exe
```

Without the real exe, an empty placeholder with that name lets builds succeed. Talkerbox treats an empty or missing
file as unavailable and shows the paths it checked on the Speech page; everything else keeps working. To enable speech,
build `../tts-sidecar` and copy the result over the placeholder under the name above, then rebuild.

Where the app looks for the sidecar:
1. Next to `talkerbox.exe` as `tts-sidecar.exe`. Tauri puts it there at build time, and the installer puts it there
   for release builds.
2. In debug builds only, as a fallback: `src-tauri/binaries/tts-sidecar-x86_64-pc-windows-msvc.exe`. The copy in
   `target/debug` is refreshed only when the build script reruns, so it could go stale. `build.rs` now reruns whenever
   `binaries/` changes.

The sidecar is started as
`tts-sidecar.exe --port <free port> --model <*.onnx> --voices <*.bin>`, with a stdin pipe that stays open. The
sidecar exits when that pipe closes, so it never outlives the app. The app waits for `GET /health`, reads
`GET /voices`, and sends `POST /synthesize` (`{"text","voice","speed"}` -> WAV) for each sentence.

Kokoro files: **Speech -> Text-to-speech model** shows them as installed once a `.onnx` of at least 20 MB and a
`.bin` of at least 1 MB are present (`kokoro-v1.0.onnx` and `voices-v1.0.bin` are preferred). In that state the
download buttons are hidden behind "Re-download…", and "Delete files" removes them. You can also choose "Use existing
folder…" (for example `tts-sidecar\models`). Files in a folder you chose are never deleted by the app.

## Vosk runtime (speech input)

The `vosk` crate links `libvosk.dll` (Vosk 0.3.45). `src-tauri/vosk/` must hold the four runtime DLLs and the MSVC
import library `libvosk.lib`; none of them are in git. Create them once with:

```powershell
py -3 -m venv $env:TEMP\vosk-venv
& "$env:TEMP\vosk-venv\Scripts\python.exe" -m pip install vosk==0.3.45
src-tauri\vosk\setup.ps1 -From "$env:TEMP\vosk-venv\Lib\site-packages\vosk"   # always pass -From
```

It copies `libvosk.dll`, `libstdc++-6.dll`, `libgcc_s_seh-1.dll` and `libwinpthread-1.dll` and builds `libvosk.lib`
from the DLL's `vosk_*` exports with `dumpbin`/`lib` from the MSVC Build Tools. `build.rs` adds the folder to the
linker path, links `libvosk.dll` with `/DELAYLOAD` (so the app and `cargo test` start without the DLL; the app checks
for it next to the exe before listening and otherwise shows "Speech input runtime missing") and copies the DLLs into
`target/<profile>/` for `tauri dev`. Release builds bundle them next to `talkerbox.exe` through `bundle.resources`.

End-to-end check of the Vosk link with a real recording (16-bit PCM WAV, DLLs copied to `target\debug\deps`):

```powershell
$env:TALKERBOX_VOSK_MODEL = '<model dir>'; $env:TALKERBOX_VOSK_WAV = '<file.wav>'
cargo test vosk_wav -- --ignored --nocapture
```

Licences: `libvosk.dll` Apache-2.0; `libstdc++-6.dll` and `libgcc_s_seh-1.dll` GPL-3.0 with the GCC Runtime Library
Exception; `libwinpthread-1.dll` MIT-style. The Vosk small models are Apache-2.0. See the third-party notices in the
top-level README.

## Smart select runtime

Nothing to set up at build time: `ort` 2.0.0-rc.15 is built with only the `load-dynamic` feature, so no ONNX Runtime
library is linked or bundled (the release exe grew by about 0.5 MB). The mask editor's download button runs
`sam_download`, which fetches three pinned files into `sam\` of the local app data dir with the resumable
downloader, checks each against its exact size and SHA-256 (a bad file is deleted), and can be cancelled:

- `onnxruntime-1.31.1-cp312-cp312-win_amd64.whl` from PyPI (14.9 MB). A wheel is a zip; only
  `onnxruntime/capi/onnxruntime.dll` (19 MB, the C API DLL that exports `OrtGetApiBase`) is unpacked, then the wheel
  is deleted. The official GitHub zip holds the same kind of DLL but is 83 MB because of debug symbols.
- `mobile_sam_image_encoder.onnx` (28.2 MB) and `sam_mask_decoder_single.onnx` (16.5 MB) from
  `huggingface.co/Acly/MobileSAM`, pinned to commit `0d3b4033`. The encoder takes the RGB image (H x W x 3, long side
  1024) and normalises and pads it itself; the decoder is the standard SAM ONNX decoder (points, labels,
  `orig_im_size`) and returns mask logits at the requested size.

ONNX Runtime allows one environment per process (`ort` refuses a second one even after the first was dropped), so
`sam.rs` creates it once and keeps it; only the two sessions and the cached embedding are created per editor and
dropped by `sam_release` when the editor closes. `sam_remove` drops a loaded model first and deletes everything in
`sam\`. The DLL stays mapped until the app exits (`ort` never unloads it) and Windows refuses to delete a loaded DLL,
so it is renamed to `*.old` instead (it no longer counts as installed) and deleted on the next start or download.

The DLL is loaded with an absolute path (never the old `onnxruntime.dll` that Windows ships in System32). It needs
the Microsoft Visual C++ runtime (`msvcp140.dll`); if it cannot be loaded, the editor says so and suggests installing
the Visual C++ Redistributable (x64). Inference runs on the CPU provider with ONNX Runtime's default thread count,
off the async runtime (`spawn_blocking`). The image goes to Rust as raw RGBA bytes (no JSON), the mask comes back as
raw bytes.

Real-model check: three editor sessions in a row (load, encode, clicks, release) on three different synthetic images,
then `remove` while the DLL is loaded; prints load/encode/decode ms and the overlap with the drawn disc (the files
are copied to a temp folder first):

```powershell
$env:TALKERBOX_SAM_DIR = "$env:LOCALAPPDATA\com.talkerbox.app\sam"   # or any folder with the three files
cargo test --release sam_real -- --ignored --nocapture
```

Why not onnxruntime-web in the WebView: its WASM files (about 10-25 MB) would ship in the installer or need their
own download plus a CSP change for WebAssembly, multi-threading needs cross-origin isolation headers, and
single-threaded WASM is several times slower than the native CPU provider. Licences: ONNX Runtime MIT; MobileSAM
Apache-2.0; the `Acly/MobileSAM` export repository is MIT.

## AI fill runtime

"Fill (AI)" uses LaMa (advimman/lama, Apache-2.0) as exported by the OpenCV Zoo: `inpainting_lama_2025jan.onnx` from
`huggingface.co/opencv/inpainting_lama` (Apache-2.0), pinned to commit `aee6d22f`, 92,591,623 bytes, SHA-256
`7df918ac3921d3daf0aae1d219776cf0dc4e4935f035af81841b40adcf74fdf2`. It is half the size of the `Carve/LaMa-ONNX`
`lama_fp32.onnx` it was derived from (208 MB) with practically identical output (mean difference 0.02 of 255 on the
test figures). Input `image` [1, 3, 512, 512] RGB 0..1 and `mask` [1, 1, 512, 512], output RGB 0..255.
`inpaint_download` fetches it into `inpaint\` with the same pinned downloader as smart select and, if missing, the
shared `onnxruntime.dll` into `sam\` (`sam::fetch_pinned`). `inpaint_run` loads the session in the process-wide ONNX
Runtime environment (`sam::environment`), runs once and drops it, so nothing stays loaded. Measured on a Ryzen 7
7700X: session load 6-9 s, inference 1.2-1.4 s per 512 px fill. `inpaint_remove` deletes only the model (the runtime
belongs to smart select). Real-model check:

```powershell
$env:TALKERBOX_SAM_DIR = "$env:LOCALAPPDATA\com.talkerbox.app\sam"; $env:TALKERBOX_LAMA_DIR = "$env:LOCALAPPDATA\com.talkerbox.app\inpaint"
cargo test --release lama_real -- --ignored --nocapture
```

## Face detection runtime

"Detect eyes and mouth" in the part editor (`src-tauri/src/face.rs`) runs two Google MediaPipe models (Apache-2.0 per
their model cards) as ONNX conversions from Hugging Face (Apache-2.0), each pinned to a commit with size and SHA-256:

- `face_detector.onnx`, BlazeFace short range, from `fernandotonon/QtMeshEditor-blazeface-onnx` at `50f2c66f`,
  418,437 bytes, `02a04d5d37c3558dc4d5274f7f8f0f0f01ac94e46c5ffb2cee82395d47e23181`. Input [1, 128, 128, 3] RGB -1..1,
  outputs 896 anchors (box and 6 keypoints, score logit).
- `face_landmarks.onnx`, Face Mesh V2, from `fernandotonon/QtMeshEditor-facemesh-onnx` at `32714088`, 4,920,979
  bytes, `d16e5a55e6a480284d468ee32469692464049518c311662ab3956681de31e3e9`. Input [1, 256, 256, 3] RGB 0..1 (the
  face crop), outputs 478 x (x, y, z) in crop pixels and a face presence logit.

`face_download` fetches both into `face\` (and the shared `onnxruntime.dll` into `sam\` if missing); `face_remove`
deletes only the models. `face_detect` gets the image as raw RGBA (long side 1024), loads both sessions in the shared
environment (`sam::environment`), and drops them after the call. The short-range detector wants a face that fills a
good part of its 128 px input, so it runs on the whole image (letterboxed) and on half-overlapping square windows of
half the size each step down to a quarter of the short side; the three best detections (score at least 0.5) are
tried in order: each is cropped as MediaPipe does (square, 1.5 times the box, rotated so the eyes are level, bilinear)
and the first with a face presence of at least 0.5 is returned, otherwise "No face found". The windows, anchor
decoding, crop and back-projection are pure and tested.

Measured (Ryzen 7 7700X, release, images scaled to a long side of 1024 as the editor sends them; test pictures from
Wikimedia Commons, public domain or CC0, not in the repository): 90-170 ms per click including loading both models.
On a photo portrait, two full-body photos (one with the head tilted and laughing) and a realistic painting every
face was found and the eye and lip contours sit on the visible edges (checked by eye at 3x zoom: within a few pixels,
about 2 % of the eye distance, on a 1280 px portrait). On drawings it is unreliable: a flat cartoon face with human proportions is
found with eye and mouth positions within 1-3 % of the face width, but the eyes come out at a third of their drawn
height (Face Mesh forces human proportions), and on a figure without a drawn mouth a mouth is placed where one would
be; a semi-realistic anime portrait works; a classic big-eyed anime face and a caricature in three-quarter view are
rejected by the presence check ("No face found"); a small chibi figure is found with flattened eyes. Pick remains the
tool for cartoons. Real-model check (binary PPM images, `<image>.json` with the landmarks is written beside each):

```powershell
$env:TALKERBOX_SAM_DIR = "$env:LOCALAPPDATA\com.talkerbox.app\sam"; $env:TALKERBOX_FACE_DIR = "$env:LOCALAPPDATA\com.talkerbox.app\face"
$env:TALKERBOX_FACE_IMAGES = 'C:\pics\a.ppm;C:\pics\b.ppm'
cargo test --release face_real -- --ignored --nocapture
```

Pose keypoints for full-body figures (study option 3a) were evaluated and not built: MoveNet SinglePose Thunder
(Apache-2.0, 25 MB ONNX, 10-30 ms) placed all 17 joints correctly on two full-body photos but failed on drawings (all
joints below 0.2 confidence on a flat cartoon figure, arms misplaced on a cartoon in a wheelchair), and Pick plus the
default pivots already cover limbs in every art style.

## Security notes

- All HTTP (Ollama, sidecar, downloads) runs in Rust. The webview's CSP allows only `'self'` and Tauri IPC.
- Window permissions: see below. No shell or filesystem plugin permissions are granted to any webview. Processes are spawned only by fixed Rust commands. Character files are only read and written under `avatars\<id>`
  with ids checked in Rust; the image path from the open dialog is only read and copied.
- Download URLs must be http(s). Local file names are sanitised to `[A-Za-z0-9._-]`.
- Smart select downloads only fixed URLs, each checked against a pinned size and SHA-256 before use; the DLL is
  loaded from the app data dir by absolute path.
- `withGlobalTauri` is off (the API comes from the bundled `@tauri-apps/api`), no capability has `remote` URLs, so
  only the app's own pages can use IPC, and the asset protocol is not enabled.

### Window permissions

`build.rs` passes an app manifest to `tauri_build` with every command from `generate_handler!` in `src/lib.rs`
(parsed from the source, so the lists cannot drift). That makes each app command a permission (`allow-<command>`,
generated into `permissions/autogenerated/`, not in git), and Tauri then rejects any app command a window was not
granted ("Command ... not allowed by ACL"). `build.rs` also writes `permissions/main-window.toml`, a set of all of
them.

- `capabilities/default.json`, window `main`: `main-window` (every app command), `core:default`,
  `dialog:allow-open`, `dialog:allow-ask`.
- `capabilities/puppet.json`, window `puppet`: only what `puppet.html` and its imports call: `allow-avatar-load`,
  `allow-avatar-image`, `allow-avatar-fill` (show the selected character and its stored AI fill),
  `allow-puppet-ready` (tells the main window it is ready; the backend emits `avatar://ready`, so the page needs no
  emit permission) and `core:event:allow-listen` / `allow-unlisten` for the `avatar://` events. It cannot call any other app command, emit events, or use window,
  app, path, webview or dialog APIs.

A new command needs no permission work for the main window; if the avatar window needs it, add its `allow-` entry
to `puppet.json`.

## Layout

```
src/                 Svelte UI (App shell, Chat, Models/Speech, Avatar page, path dialog, theme, fit toolbars, speaker queue,
                     typed API wrappers); avatar: MaskEditor/PartEditor, rig*.ts, mouthWarp, viseme, poseGen,
                     smartSelect/smartSession (shared smart select), puppet window (puppet.html, PuppetView)
tests/               node --test unit tests for the pure modules
src-tauri/src/
  lib.rs             Tauri commands, app state, process handling
  ollama.rs          Ollama HTTP client (chat, tags, pull, delete, blobs/create) + `ollama serve`
  discovery.rs       ollama.exe lookup order (unit-tested)
  hf.rs              HuggingFace link -> hf.co/user/repo[:quant] (unit-tested)
  names.rs           short display names for models (unit-tested)
  packs.rs           language packs: pack.json, ids, listing (unit-tested)
  term.rs            ring buffer + events for the Ollama terminal view (unit-tested)
  download.rs        resumable streaming downloads
  tts.rs             sidecar lifecycle and HTTP calls
  stt.rs             speech input: mic capture, resampling, Vosk, idle timer, model zip install (unit-tested)
  avatar.rs          avatar window: open/close, transparency, saved bounds (unit-tested)
  rig.rs             avatar characters: rig.json model, validation, image import (unit-tested)
  sam.rs             smart select: pinned downloads, ONNX Runtime + MobileSAM encoder/decoder (unit-tested)
  inpaint.rs         AI fill under moved parts: LaMa download and one-shot inference (unit-tested)
  config.rs          settings.json
```
