# Creative Studio

A loopback browser editor for testing and using NaviChrome’s structured edit
workflow. Documents, slide objects and tracks have stable IDs. The app checks
the expected revision and values before saving a batch atomically.

Run `npm run studio` from the checkout. It prints the loopback origin and
project directory. Open `/document`, `/slides`, or `/video` on that origin.
Set `NAVICHROME_STUDIO_DIR` to the same private project directory on a later
launch to reopen the saved state. Video import and MP4 render require FFmpeg
and FFprobe on the server path. Sources are local files chosen in the browser.

## Use with NaviChrome

After opening the exact editor and reading its current revision, send a
`workflow` step with this structure. Populate `url` with the exact editor URL.

```json
{
  "kind": "app_adapter_plan",
  "adapter": "creative_edit_v1",
  "predicate": {
    "version": 1,
    "url": "http://127.0.0.1:8080/document",
    "revision": 0,
    "apply": true,
    "edits": [
      {
        "kind": "replace_text",
        "id": "intro",
        "expected": "This first paragraph needs a clearer opening.",
        "text": "State the decision in the first paragraph."
      }
    ]
  }
}
```

Set `apply: false` to stage and preview. Then submit the same revision and
edits with `apply: true` and `resume_preview: true`. The saved receipt must
match the hash of the exact request, and a stale preview fails before commit.
After an unknown result, inspect the current status and revision before acting.

| Editor | Operations |
| --- | --- |
| Document | `replace_text`, `suggest_text` (with `suggestion_id`), `accept_suggestion`, `reject_suggestion` |
| Slides | `replace_text` (with `slide` and object `id`), `move_object` (old and new x/y), `replace_notes` |
| Video | Import media through the file input, then use `trim_clip`, `split_clip`, `move_clip`, `set_gain`, and `add_caption`. |

Video ranges are half-open integer frames at 30 fps. Clip offsets are in the
source, and caption offsets are on the edited timeline. The current editor
uses one sequential track with a two-minute bound. The rendered MP4 contains
H.264 video, AAC audio, and an optional timed subtitle track. The preview can
seek to an exact timeline frame. Before exposing the output link, the server
checks the media stream types, resolution, frame rate, frame count, and hash
from the file that actually rendered. A semantic render receipt does not
establish editorial quality.

Creative Studio is a controlled application. Its revision and export evidence
does not qualify third-party editors, account scopes, or their persistence.
