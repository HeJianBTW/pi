---
name: video-gen
description: "Agentic video creation: single clips via video_generate, and multi-shot films via the shot-book workflow — you write the shot book in conversation, generate frames with image_generate (pi-image-gen), then video_render pays for and stitches the clips. Use when the deliverable is a video. Do NOT use for still images (use pi-image-gen directly)."
---

# Video generation

This skill orchestrates `@amaster.ai/pi-video-gen` (video providers + render) and
`@amaster.ai/pi-image-gen` (all image work). The video model is fixed by
`pi-video-gen.defaultModel`; images use pi-image-gen's active model.

Two flows:

- **Single clip** — one `video_generate` call. Product motion, logo sting, cinemagraph.
- **Shot-book film** — you (the agent) author a shot book in conversation, generate
  all frames with `image_generate`, then ONE `video_render` call renders and stitches.

## A. Workflow rules

1. **Pick the right flow.** A vague idea or a script that needs multiple shots →
   shot-book flow. A single moving image → `video_generate`. A still → pi-image-gen.
2. **Preflight.** Before composing anything, call `video_capabilities` and confirm
   `image_generate` is available (`/video-gen doctor` checks; config health is
   `/image-gen list`). Respect the active model's duration range and audio support.
3. **Write the shot book in conversation** (schema in §B). If the user only has a
   vague idea, first be the screenwriter: three-act structure, filmable actions
   ("show, don't tell"), concrete visual detail. Iterate with the user in chat.
4. **Confirmation gate 1 (mandatory).** Show the shot-book summary — shot count,
   character list, estimated image calls (~2N+3C) and video calls (N) — and get an
   explicit go-ahead. **Default small: 1 scene, 3–5 shots** unless the user asks
   for more.
5. **Image stage (all via `image_generate`, per §C).** Character portraits →
   per-shot first frame (and last frame when needed). Show each batch to the user.
6. **Confirmation gate 2 (mandatory).** Frames ready → state "about to make N paid
   video calls" and get an explicit render order. Then assemble the render spec
   and call `video_render` ONCE.
7. **Cost honesty.** Video calls are paid and take minutes each. Never state
   amounts (prices change); state call counts and durations.
8. **Revisions.** The render spec is immutable per job directory. Text-stage
   revisions happen in chat (regenerate frames as needed); a revised film goes in
   a NEW job directory. NEVER suggest "delete shots/<id>/ and rerender" — that
   breaks downstream dependencies. Rerunning the SAME spec path resumes an
   interrupted job (finished shots don't re-bill).
9. **Degradation negotiation.** If `video_render` preflight fails (e.g. last
   frame unsupported), present the options (switch model / edit spec /
   `allowDegradations`) and let the user choose. Never degrade silently. When the
   model's `nativeAudio` is false, don't write audio cues into video prompts
   unless the user accepted silence.
10. **Cancellation honesty.** Interrupting stops local polling only — remote
    tasks may keep running and billable (Ark cancellation is unverified). Say so.

## B. Shot book (VideoProject) — authoring reference

Author as JSON in conversation; save to `<jobDir>/project.json` for the record.

```jsonc
{
  "title": "...", "style": "Cartoon",
  "characters": [{ "id": "alice", "visible": true,
    "appearance": "long blonde hair, blue eyes, slender",   // static features
    "outfit": "red scarf, black leather jacket" }],          // dynamic features
  "shots": [{
    "id": "s1",
    "intent": "Wide shot, rainy alley. <Alice> enters from the left, stops under the streetlamp…",
    "firstFrame": "…pure static description of the FIRST frame…",
    "lastFrame": "…(optional) pure static description of the LAST frame…",
    "motion": "Static camera. A woman with long blonde hair and a red scarf walks in from the left…",
    "audio": "[Sound Effect] rain, distant traffic. [Speaker] Alice (soft): \"We're here.\"",
    "visibleCharacters": ["alice"],
    "durationSec": 5,
    "continuityGroup": "alley",
    "startFrameFromShotId": "s0",   // optional: this shot's frame builds on s0's frame
    "continuityNote": "In s0's frame Alice faces away; front view missing"
  }]
}
```

Field rules:

- **Every shot needs a narrative purpose** (establish / emotion / reaction). First
  shot: widest view of the scene. Close-ups for emotion, wide shots for context.
- **At most one dialogue line per shot.** Character names in `intent` are wrapped
  in angle brackets: `<Alice>`.
- **firstFrame / lastFrame are pure static snapshots** — no ongoing actions
  ("he is sitting, leaning forward", NOT "he is about to stand"). Include shot
  size, angle, composition, who is where and facing which way.
- **motion = camera movement + in-frame movement**, named separately. Refer to
  characters by visible traits ("the woman in the red scarf"), never by name.
- **lastFrame needed when**: composition/focus changes drastically, a character
  enters or turns to face camera, a major reveal happens. Otherwise omit it.
- **Few camera positions.** Default: one `continuityGroup` for everything. New
  group only when shot size/angle/focus differs significantly.
- **continuityGroup** = shots sharing a space/base image; **startFrameFromShotId**
  pins a specific parent frame for composition; **continuityNote** says what the
  parent frame lacks (the frame prompt must then keep the background and replace
  those elements). Self-check: parent shot EXISTS, comes EARLIER, same
  continuityGroup, no cycles.
- **audio** uses `[Sound Effect] …` / `[Speaker] Name (Emotion): "line"` format.
- **durationSec and all capability values come from `video_capabilities`** —
  never from memory or this document. Durations, resolutions, ratios, audio and
  frame support differ per model and change over time.
- **Behavioral quirks worth knowing** (still verify with `video_capabilities`):
  some models have no native audio (omit audio cues or the render is silent);
  some cannot do last-frame interpolation (never pass lastFrame to them);
  HappyHorse takes a first frame OR reference images in one call, not both —
  cite references in the prompt as `[Image 1]`, `[Image 2]`, …

## C. Image operation manual (via `image_generate`)

Generic `image_generate` usage (params, sizes, `n`, edit labeling) follows the
**pi-image-gen skill** — it is the single authority; do not deviate. Two
video-specific handoff rules:

- **Never assume a saved filename**: the actual extension follows the MIME type
  and collisions get `-v2`. **The returned absolute path is the only truth** —
  record it immediately in `assets.json` (see below) and reference it in the
  render spec.
- `assets.json` in the job dir: `{ "assets": { "<shotId>/<part>": { "sourcePath": "…" } } }`
  mapping semantic assets (e.g. `s1/firstFrame`, `alice/front`) to real paths.

**Character portraits (3 views per visible character)**:

- front (text-to-image): `Generate a full-body, front-view portrait of character {identifier} based on the following description, with a pure white background. Use a wide 16:9 landscape canvas, not a vertical portrait canvas. The character should be centered in the image, occupying the middle of the wide frame with enough horizontal empty space. Gazing straight ahead. Standing with arms relaxed at sides. Natural expression. Features: {appearance}; {outfit}. Style: {style}`
- side (edit with front as reference): `Generate a full-body, side-view portrait of character {identifier} based on the provided front-view portrait, with a pure white background. Use a wide 16:9 landscape canvas, not a vertical portrait canvas. The character should be centered in the image, occupying the middle of the wide frame with enough horizontal empty space. Facing left. Standing with arms relaxed at sides.`
- back (edit with front as reference): `Generate a full-body, back-view portrait of character {identifier} based on the provided front-view portrait, with a pure white background. Use a wide 16:9 landscape canvas, not a vertical portrait canvas. The character should be centered in the image, occupying the middle of the wide frame with enough horizontal empty space. No facial features should be visible.`

If side/back fails after one retry, reuse front. Characters with `visible: false`
get no portraits.

**Reference selection for frames**:
candidates = portraits of visible characters (ONE view each, chosen by facing) +
continuity frames. Pick a SMALL set of the most relevant ones — same
camera/group first, most recent frames first, drop redundant near-duplicates,
prefer the portrait when a character newly appears. How many images a call
accepts is pi-image-gen's authority (its skill/tool description), not this
document's.

**Frame prompt assembly**: prefix each reference image with its role, then the
frame description mapping elements to images:

```
Image 0: A front view portrait of Alice.
Image 1: [alley] Wide shot of the rainy alley from shot s1.
Create an image based on the following description: <firstFrame text>. The alley
background should reference Image 1; Alice's appearance should reference Image 0.
```

## D. Assemble the render spec and render

Write `<outputDir>/<jobId>/render-input.json` (jobId: letters/digits/dash/underscore):

```jsonc
{
  "title": "…", "aspectRatio": "16:9",
  "shots": [{
    "id": "s1",
    "videoPrompt": "<motion> + <audio cues>",
    "firstFramePath": "/abs/path/from/assets.json.png",
    "lastFramePath": "/abs/optional.png",
    "durationSec": 5
  }]
}
```

Then call `video_render` with that path. Interrupted? Call it again with the
same path — it resumes. If an ambiguous submit is reported, do not delete a
shot or call render again blindly: run `/video-gen recover <jobId>`, check the
provider console, then explicitly `reset` a confirmed-absent task or `adopt`
its task id. Revisions? New job directory.
