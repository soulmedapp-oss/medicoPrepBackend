# Bunny-hosted lecture videos + per-video AI chat

Date: 2026-09-22
Status: Approved design, ready for implementation planning

## 1. Problem

Admins need to publish SoulMed's own recorded lectures against a subject. Today
`Video.video_url` is a free-text string: the student player sniffs it and either
embeds YouTube or drops it into a raw `<video>` tag. There is no way to host our
own lecture files such that a paying student can watch them but cannot copy the
URL into a WhatsApp group for 200 non-payers.

Two constraints come from the existing system:

- **Video bytes must never pass through the API.** API Gateway caps request
  payloads at 10 MB, and the current `POST /uploads/videos` route buffers up to
  200 MB in memory — unusable on Lambda.
- **`canAccessVideo` is already correct** and must remain the single access gate.
  It needs to guard a short-lived token instead of a static URL.

## 2. Goals

- Admin uploads a lecture file, files it under a subject, and publishes it.
- Students discover lectures by subject and see only what their plan allows.
- A shared playback URL stops working quickly.
- A student can ask an AI chatbot about the lecture they are watching, with the
  chat scoped to that lecture only.

## 3. Non-goals

- DRM (Widevine/FairPlay), per-student visible watermarking, and defence against
  screen recording. The agreed threat model is casual link sharing between
  students, not organised piracy.
- Offline downloads in a mobile app.
- Replacing the existing YouTube/link workflow. It stays.
- Converting `Video.subject` from a String to a `Subject` reference (see §12).

## 4. Decisions

| Decision | Choice | Why |
| --- | --- | --- |
| Provider | **Bunny Stream** | ~3x cheaper than Cloudflare Stream/Mux at Indian delivery rates ($0.03/GB Asia standard network); free encoding; token auth and tus resumable uploads included; 14-day free trial, $1/month minimum. |
| Provider coupling | **Adapter interface** | `createUpload / getPlaybackToken / getStatus / delete`. Volume is unsettled; switching providers should be a new adapter, not a schema rewrite. |
| Storage | **Extend `Video`**, no new collection | Student discovery, plan gating, `VideoProgress` and the AI chat endpoints keep working unchanged. A second collection would fork all of it. |
| Admin UI | **New page**, existing one untouched | Explicit product decision. `AdminVideos.jsx` keeps the link workflow. |
| Student UI | **One merged list** | The admin split is an internal concern. Students should not have to guess whether Pharmacology lives under "Videos" or "Lectures". |

Bunny's storage origin for us is **Singapore** — there is no India region yet
(Mumbai is listed as planned). Delivery reaches students from Bunny's Indian PoPs
(Mumbai, Delhi, Bangalore, Chennai, Kolkata). A lecture library caches well, so
only the first viewer of a freshly published lecture pays the origin round trip.

## 5. Data model

Added to `src/models/Video.js`:

```js
provider:          { type: String, enum: ['youtube', 'bunny'], default: 'youtube' },
bunny_video_id:    { type: String, default: '' },   // GUID
bunny_library_id:  { type: String, default: '' },
processing_status: { type: String, enum: ['uploading','processing','ready','failed'], default: 'ready' },
duration_seconds:  { type: Number, default: 0 },
transcript_status: { type: String, enum: ['none','pending','ready','failed'], default: 'none' },
```

`video_url` becomes required only when `provider === 'youtube'` (schema-level
conditional `required`). `processing_status` defaults to `ready` so existing rows
are unaffected.

Index: `{ provider: 1, processing_status: 1 }` for the new admin page's listing.

**No data migration.** Existing rows default to `provider: 'youtube'` and keep
working in both the old admin page and the old player branch.

## 6. Bunny configuration (external, done in the Bunny dashboard)

1. Create a **Stream video library**, main storage region **Singapore**.
   Replication regions cannot be removed once set — choose deliberately.
2. **Security tab**: enable **CDN Token Authentication** and **Embed View Token
   Authentication**. Without these the HLS URL is public and the token scheme is
   decorative.
3. **Security tab**: set allowed referrers to our app domains. Disable **Direct
   Play** and **MP4 fallback** so there is no unsigned path to the file.
4. Record the **Library ID**, **API key**, **Read-Only API key**, **Token
   Security Key**, and the library's **CDN hostname**.
5. Set the **webhook URL** to `POST /webhooks/bunny/video-status`.
6. Leave automatic transcription **off** for Phases 0-1. Enable it on the library
   only when the Phase 2 pilot starts, and only for the ~20 pilot lectures — it
   bills per minute of video (see §10).

### Environment variables

```
VIDEO_PROVIDER=bunny
BUNNY_STREAM_LIBRARY_ID=
BUNNY_STREAM_API_KEY=            # write; server-side only
BUNNY_STREAM_READONLY_API_KEY=   # webhook signing secret
BUNNY_STREAM_TOKEN_KEY=          # playback token security key
BUNNY_STREAM_CDN_HOSTNAME=       # e.g. vz-xxxx.b-cdn.net
BUNNY_PLAYBACK_TOKEN_TTL=14400   # seconds (4h)
```

None of these may reach the browser.

## 7. Backend

### 7.1 Provider adapter — `src/services/video/`

```
index.js          -> resolves provider from VIDEO_PROVIDER
bunnyProvider.js  -> createUpload / getPlaybackToken / getStatus / delete
youtubeProvider.js-> no-op create; playback returns the stored video_url
```

Controllers talk only to the interface, never to Bunny directly.

### 7.2 Upload

`POST /videos/:id/upload-url` — `authorize.any('CanAddVideos','CanEditVideos')`

1. Call Bunny's Create Video API → GUID.
2. Persist `bunny_video_id`, `bunny_library_id`, `processing_status: 'uploading'`.
3. Return the **tus endpoint** plus signature
   `SHA256(library_id + api_key + expiration_time + video_id)` and the expiry.

The browser then uploads directly to Bunny over tus (resumable: a teacher who
loses a 2 GB upload at 90% resumes rather than restarting). The API key is never
sent to the client — only the derived signature.

### 7.3 Status webhook

`POST /webhooks/bunny/video-status` — unauthenticated route, verified by signature.

Payload: `{ VideoLibraryId, VideoGuid, Status }`. Status codes: `3` = Finished,
`5` = Failed, `9` = Captions generated.

Verification: `lowercase_hex(HMAC-SHA256(rawBody, readonly_api_key))` compared
constant-time against the `X-BunnyStream-Signature` header.

> **Implementation gotcha:** verification needs the *exact raw body*.
> `express.json()` parses and discards it. Mount this route with a raw body
> parser, or add `verify: (req, res, buf) => { req.rawBody = buf }` to the JSON
> parser. Parsing and re-serialising breaks the signature.

Handler maps `3 -> ready` (also storing duration and thumbnail via `getStatus`),
`5 -> failed`, `9 -> transcript_status: 'ready'` then fetches the VTT.

Webhooks are unreliable by nature: a reconciliation job (or an admin "refresh
status" action) should poll `getStatus` for rows stuck in `processing` beyond a
threshold.

### 7.4 Playback authorization

`GET /videos/:id/playback` — `authorize.any('CanAccessVideos','CanViewVideos')`

1. `loadVideoForUser(req.user, req.params.id)` — the existing check: published,
   active, and `canAccessVideo` against the user's plan. Unchanged.
2. `provider === 'youtube'` → return the stored `video_url`.
3. `provider === 'bunny'` → `expires = now + TTL`, token =
   `SHA256_HEX(token_security_key + video_id + expires)`; return
   `{ hls_url, token, expires_at }`.

TTL 4 hours: longer than any lecture plus pauses, short enough that a shared link
is dead before it spreads. **The token is returned only by this endpoint and must
never appear in `GET /videos` list responses.**

`GET /videos` needs no change — it already filters by publish state, active
state and plan, and drops inaccessible videos from the response entirely.

## 8. Frontend

### 8.1 New admin page — `AdminLectures.jsx`

Lists `provider: 'bunny'` rows. Same metadata fields as the existing page
(subject dropdown, title, teacher, subtopic, order, allowed plans) plus:

- A file picker that uploads via tus with a progress bar and resume support.
- A visible **processing state**. This is the one genuinely new admin concept: a
  video exists but is not watchable for a few minutes after upload.
- **Publish disabled until `processing_status === 'ready'`.**

Registered in `navItems.js` under the AI/content area, gated by `CanAddVideos`,
and added to `pages.config.js`. It sorts alphabetically like everything else.

`AdminVideos.jsx` is not modified.

### 8.2 Student player — `Videos.jsx`

Replace the URL-sniffing block at `Videos.jsx:452-465` with a branch on
`provider`: YouTube rows keep the existing iframe; Bunny rows call
`GET /videos/:id/playback` and render the HLS player. `VideoProgress` tracking
works off player time events either way.

Discovery, subject grouping and plan gating are unchanged.

### 8.3 AI chat panel

A panel beside the player. The backend already exists and is unchanged in shape:

- `GET /videos/:id/ai-summary`
- `POST /videos/:id/ai-chat` (rate-limited, 10/min/user)
- `videosClient.js:48-52` already has both calls wired

Only the UI is missing.

## 9. AI chat design

`buildVideoContext` already restricts context to title, subject, teacher,
subtopic, description and transcript — the video-only scoping we want. Four
changes:

1. **Conversation memory.** `requestVideoChat(message, video)` sends a single
   message with no history, so "explain that more simply" loses its referent.
   Accept the last N turns from the client (N small, total length capped,
   truncated with the existing `truncateText`).
2. **Refusal guardrail.** The context is video-only but the model will still
   answer off-topic questions from general knowledge. The system prompt must
   explicitly decline and say the lecture does not cover it. This is the part
   most likely to embarrass us in front of students.
3. **Timestamp awareness.** Once timed VTT cues exist, cues carry their start
   time into the context so a student can ask "what did she mean at 12:30", and
   answers can deep-link the player.
4. **Transcript dependency.** Chat quality is bounded by `transcript_text`. See §10.

Chat history is not persisted server-side in this iteration.

## 10. Transcription

Bunny's Transcribe AI is Whisper-based, timestamped, 57 languages, at
**$0.10/minute per language** — $4.50 for a 45-minute lecture, ~$4,500 for a
1,000-lecture library.

OpenAI's Whisper API is roughly **$0.006/minute** — ~$270 for the same library,
about 16x cheaper. The `openai` dependency and an API key are already in the
project.

**Plan:** use Bunny's transcription for the first ~20 lectures (it is a library
setting, and player captions come free) to validate accuracy on medical
terminology, then move bulk transcription to our own Whisper job. Captions are
worth keeping regardless — accessibility, and students watching in noisy places.

## 11. Rollout

**Phase 0 — AI chat UI.** No Bunny dependency. The backend and API client
already exist; this works today against existing videos with a hand-pasted
transcript. Fastest visible win, and it de-risks the chat UX before video
hosting complicates things.

**Phase 1 — Bunny upload and playback.** Adapter, the three endpoints, the
webhook, the new admin page, the player branch.

**Phase 2 — Transcription.** Feeds §9 and improves chat across the whole library.

## 12. Risks and open questions

- **`Video.subject` is a plain String, not a ref.** Renaming a subject silently
  orphans every video filed under the old name. Out of scope here, but it will
  bite, and the cost grows with row count.
- **Token auth must actually be enabled on the library.** If §6.2 is skipped the
  entire protection scheme is theatre. Verify explicitly during implementation.
- **Webhook raw-body handling** (§7.3) is the most likely source of a silent
  "videos stay stuck in processing" bug.
- **Singapore origin** until Bunny ships Mumbai.
- **Bunny has no Indian edtech reference customers** that we could find; its
  public case studies are gaming and software. Accepted, mitigated by the adapter.
- **Transcription spend** needs a cap before bulk processing.
- **Open:** which roles beyond `CanAddVideos` may upload lectures?
- **Open:** should failed uploads auto-delete the orphaned Bunny video object?

## 13. Testing

Existing suite is `node --test test/**/*.test.js`.

- Token generation: known key/id/expiry produces the expected SHA256 hex.
- Webhook signature: valid signature accepted; tampered body rejected;
  re-serialised body rejected (guards the §7.3 gotcha).
- `GET /videos/:id/playback`: unpublished, inactive, and wrong-plan users get the
  existing errors and no token; entitled user gets a token with the expected TTL.
- `GET /videos` never includes a playback token for any user.
- Provider branch: YouTube rows return `video_url`; Bunny rows return HLS.
- AI chat: off-topic question triggers the refusal guardrail; history is capped.
