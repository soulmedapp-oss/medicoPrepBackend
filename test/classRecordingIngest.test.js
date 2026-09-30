const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { ingestZoomRecording, pickTranscript, pickMp4, recordingLectureTitle } = require('../src/services/classRecordingIngest');
const { transcriptToPlainText } = require('../src/utils/transcriptText');
// The REAL picker the controller uses for recording_url, deliberately handed to
// the ingest as a dep it must ignore: pickRecording falls back to files[0] when
// there is no MP4, and the ingest must never hand that to Bunny.
const { pickRecording } = require('../src/services/zoomService');

const oid = () => new mongoose.Types.ObjectId();
const VTT = 'WEBVTT\n\n1\n00:00:01.000 --> 00:00:03.000\nHello <v Dr Rao>everyone</v>\n\n2\n00:00:03.000 --> 00:00:05.000\nToday: the nephron.\n';

function deps(overrides = {}) {
  const calls = {
    downloads: [], stored: [], created: [], fetched: [], videoCreates: [],
    classUpdates: [], claims: [], deleted: [], subjects: [], errors: [],
  };
  // Mutable so a test can make the conditional claim lose the race.
  const state = { claim: { _id: 'claimed' } };
  const d = {
    calls,
    state,
    pickRecording,
    downloadRecordingFile: async (file, options = {}) => { calls.downloads.push({ file, options }); return Buffer.from(VTT); },
    tokenedDownloadUrl: async (url, { token } = {}) => `${url}?access_token=${token || 'ACCOUNT'}`,
    storeUpload: async (file, validated, folder) => { calls.stored.push({ name: file.originalname, folder, ext: validated.ext }); return `https://bucket/${folder}/x.vtt`; },
    createUpload: async ({ title, subject }) => { calls.created.push({ title, subject }); return { videoId: 'bunny-1', libraryId: 'lib-1' }; },
    fetchFromUrl: async (videoId, url) => { calls.fetched.push({ videoId, url }); },
    deleteVideo: async (videoId) => { calls.deleted.push(videoId); return { deleted: true }; },
    resolveSubjectForWrite: async (name) => { calls.subjects.push(name); return null; },
    Video: { create: async (doc) => { calls.videoCreates.push(doc); return { ...doc }; } },
    LiveClass: {
      findOneAndUpdate: async (filter, update) => { calls.claims.push({ filter, update }); return state.claim; },
      updateOne: async (filter, update) => { calls.classUpdates.push(update); },
    },
    logger: { child: () => ({ info: () => {}, warn: () => {} }) },
    reportError: (_req, err) => calls.errors.push(err.message),
    ...overrides,
  };
  return d;
}

const files = [
  { file_type: 'MP4', download_url: 'https://zoom/rec.mp4', play_url: 'https://zoom/play' },
  { file_type: 'TRANSCRIPT', download_url: 'https://zoom/rec.vtt' },
  { file_type: 'CHAT', download_url: 'https://zoom/chat.txt' },
];
// No subject_id: LiveClass has no such column. The lecture's subject_id comes
// from resolving the class's subject NAME (see the subject test below).
const liveClass = () => ({
  _id: oid(), title: 'Renal physiology', subject: 'Physiology', teacher_name: 'Dr Rao', teacher_email: 'rao@x.com',
  scheduled_date: new Date('2026-09-30T04:30:00Z'), zoom_recording_files: files, transcript_text: '', created_by: oid(),
});

const unsetClaim = (d) => d.calls.classUpdates.filter((u) => u.$unset && 'zoom_ingest_claimed_at' in u.$unset);

test('transcriptToPlainText drops headers, numbers, timestamps, NOTE blocks and tags', () => {
  assert.equal(transcriptToPlainText(VTT), 'Hello everyone Today: the nephron.');
  assert.equal(transcriptToPlainText('NOTE hi\n\n00:01,000 --> 00:02,000\nA\n'), 'A');
  // The BOM is stripped by an escape, not a literal BOM in the source.
  assert.equal(transcriptToPlainText('﻿WEBVTT\n\nHi\n'), 'Hi');
});

test('pickTranscript / pickMp4 / recordingLectureTitle', () => {
  assert.equal(pickTranscript(files).download_url, 'https://zoom/rec.vtt');
  assert.equal(pickTranscript([]), null);
  assert.equal(pickMp4(files).download_url, 'https://zoom/rec.mp4');
  // The whole point of the local picker: no MP4 means no video, where
  // zoomService.pickRecording would have returned the audio file.
  assert.equal(pickMp4([{ file_type: 'M4A', download_url: 'https://zoom/a.m4a' }]), null);
  assert.equal(recordingLectureTitle(liveClass()), 'Renal physiology (2026-09-30) — recording');
});

test('ingest: stores the transcript, hands the MP4 to Bunny, creates a linked lecture, links the class', async () => {
  const d = deps();
  const lc = liveClass();
  const result = await ingestZoomRecording(lc, d);
  assert.deepEqual([result.transcript, result.video], ['stored', 'created']);
  assert.equal(d.calls.downloads[0].file.file_type, 'TRANSCRIPT', 'only the transcript is downloaded by us');
  assert.deepEqual(d.calls.stored[0], { name: 'Renal physiology.vtt', folder: 'transcripts/classes', ext: 'vtt' });
  assert.deepEqual(d.calls.classUpdates[0], { $set: { transcript_url: 'https://bucket/transcripts/classes/x.vtt', transcript_text: 'Hello everyone Today: the nephron.' } });
  assert.deepEqual(d.calls.created[0], { title: 'Renal physiology (2026-09-30) — recording', subject: 'Physiology' });
  assert.deepEqual(d.calls.fetched[0], { videoId: 'bunny-1', url: 'https://zoom/rec.mp4?access_token=ACCOUNT' }, 'Bunny fetches the MP4 from Zoom with the token');
  const created = d.calls.videoCreates[0];
  assert.equal(created.provider, 'bunny');
  assert.equal(created.bunny_video_id, 'bunny-1');
  assert.equal(created.processing_status, 'processing');
  assert.equal(String(created.source_live_class_id), String(lc._id));
  assert.equal(created.transcript_text, 'Hello everyone Today: the nephron.', 'the lecture gets the transcript too');
  // The _id is preallocated, so the lecture row and the class's
  // recording_video_id are the same id with no read-back in between.
  assert.equal(String(d.calls.classUpdates[1].$set.recording_video_id), String(created._id));
  assert.equal(String(result.lectureId), String(created._id));
  assert.deepEqual(d.calls.errors, []);
  assert.deepEqual(unsetClaim(d), [], 'a clean run keeps its claim');
});

test('ingest is idempotent: an existing transcript and recording_video_id are left alone', async () => {
  const d = deps();
  const lc = { ...liveClass(), transcript_text: 'admin uploaded this', recording_video_id: oid() };
  const result = await ingestZoomRecording(lc, d);
  assert.deepEqual([result.transcript, result.video], ['skipped', 'skipped']);
  assert.equal(d.calls.downloads.length, 0);
  assert.equal(d.calls.created.length, 0);
  assert.equal(d.calls.classUpdates.length, 0);
});

test('ingest: a Bunny failure is reported and does not throw; the transcript still lands', async () => {
  const d = deps({ createUpload: async () => { throw new Error('bunny down'); } });
  const result = await ingestZoomRecording(liveClass(), d);
  assert.deepEqual([result.transcript, result.video], ['stored', 'failed']);
  assert.deepEqual(d.calls.errors, ['bunny down']);
  assert.equal(d.calls.videoCreates.length, 0, 'no lecture without a Bunny video');
  assert.equal(d.calls.deleted.length, 0, 'nothing to clean up: createUpload never returned an id');
});

test('ingest: no transcript file and no MP4 → nothing happens, nothing reported', async () => {
  const d = deps();
  const result = await ingestZoomRecording({ ...liveClass(), zoom_recording_files: [{ file_type: 'CHAT' }] }, d);
  assert.deepEqual([result.transcript, result.video], ['none', 'none']);
  assert.deepEqual(d.calls.errors, []);
});

// --- the claim (the webhook is answered before this runs, so deliveries overlap)

test('ingest: the claim is a conditional update on zoom_ingest_claimed_at being absent', async () => {
  const d = deps();
  const lc = liveClass();
  await ingestZoomRecording(lc, d);
  assert.equal(d.calls.claims.length, 1);
  const { filter, update } = d.calls.claims[0];
  assert.equal(String(filter._id), String(lc._id));
  assert.deepEqual(filter.zoom_ingest_claimed_at, { $exists: false });
  assert.ok(update.$set.zoom_ingest_claimed_at instanceof Date);
});

test('ingest: a second, concurrent delivery loses the claim and does nothing at all', async () => {
  const d = deps();
  d.state.claim = null; // the conditional update matched nothing
  const result = await ingestZoomRecording(liveClass(), d);
  assert.deepEqual([result.transcript, result.video, result.reason], ['skipped', 'skipped', 'claimed']);
  assert.equal(d.calls.downloads.length, 0);
  assert.equal(d.calls.created.length, 0);
  assert.equal(d.calls.fetched.length, 0);
  assert.equal(d.calls.classUpdates.length, 0, 'the loser writes nothing, not even a claim release');
});

test('ingest: a failed video step releases the claim so a redelivery can retry it', async () => {
  const d = deps({ fetchFromUrl: async () => { throw new Error('fetch refused'); } });
  const result = await ingestZoomRecording(liveClass(), d);
  assert.equal(result.video, 'failed');
  assert.deepEqual(unsetClaim(d), [{ $unset: { zoom_ingest_claimed_at: '' } }]);
});

test('ingest: a failed transcript step releases the claim too', async () => {
  const d = deps({ downloadRecordingFile: async () => { throw new Error('zoom 401'); } });
  const result = await ingestZoomRecording(liveClass(), d);
  assert.equal(result.transcript, 'failed');
  assert.equal(result.video, 'created', 'the video step is independent of the transcript step');
  assert.deepEqual(unsetClaim(d), [{ $unset: { zoom_ingest_claimed_at: '' } }]);
});

// --- MP4 only

test('ingest: an M4A + TRANSCRIPT recording set stores the transcript and makes no Bunny call', async () => {
  const d = deps();
  const lc = {
    ...liveClass(),
    zoom_recording_files: [
      { file_type: 'M4A', download_url: 'https://zoom/audio.m4a' },
      { file_type: 'TRANSCRIPT', download_url: 'https://zoom/rec.vtt' },
    ],
  };
  // The real picker WOULD have handed the audio file over — proof the ingest
  // does not lean on its files[0] fallback.
  assert.equal(d.pickRecording(lc.zoom_recording_files).file_type, 'M4A');
  const result = await ingestZoomRecording(lc, d);
  assert.deepEqual([result.transcript, result.video], ['stored', 'none']);
  assert.equal(d.calls.created.length, 0, 'no Bunny video');
  assert.equal(d.calls.fetched.length, 0, 'no Bunny fetch');
  assert.deepEqual(d.calls.errors, []);
});

// --- the recording's own download token

test('ingest: the webhook download token is used for our download and for Bunny\'s fetch URL', async () => {
  const d = deps({ downloadToken: 'DL-TOKEN' });
  await ingestZoomRecording(liveClass(), d);
  assert.equal(d.calls.downloads[0].options.token, 'DL-TOKEN');
  assert.equal(d.calls.fetched[0].url, 'https://zoom/rec.mp4?access_token=DL-TOKEN');
});

// --- subject resolution (LiveClass stores only the name)

test('ingest: the lecture gets subject_id when the class subject resolves, and the name either way', async () => {
  const subjectId = oid();
  const d = deps({ resolveSubjectForWrite: async (name) => ({ _id: subjectId, name: `${name}` }) });
  await ingestZoomRecording(liveClass(), d);
  const created = d.calls.videoCreates[0];
  assert.equal(String(created.subject_id), String(subjectId));
  assert.equal(created.subject, 'Physiology');
});

test('ingest: an unresolvable subject leaves subject_id unset and still creates the lecture', async () => {
  const d = deps({
    resolveSubjectForWrite: async () => { const err = new Error('subject is not active'); err.code = 'SUBJECT_INACTIVE'; throw err; },
  });
  const result = await ingestZoomRecording(liveClass(), d);
  assert.equal(result.video, 'created');
  const created = d.calls.videoCreates[0];
  assert.equal(created.subject_id, undefined);
  assert.equal(created.subject, 'Physiology');
  assert.deepEqual(d.calls.errors, [], 'an inactive subject is not an ingest failure');
});

// --- no orphan encodes

test('ingest: a failure after createUpload deletes the Bunny video so nothing encodes unreferenced', async () => {
  const d = deps({ fetchFromUrl: async () => { throw new Error('fetch refused'); } });
  await ingestZoomRecording(liveClass(), d);
  assert.deepEqual(d.calls.deleted, ['bunny-1']);
});

test('ingest: a failing cleanup is reported, never thrown', async () => {
  const d = deps({
    fetchFromUrl: async () => { throw new Error('fetch refused'); },
    deleteVideo: async () => { throw new Error('bunny delete 500'); },
  });
  const result = await ingestZoomRecording(liveClass(), d);
  assert.equal(result.video, 'failed');
  assert.deepEqual(d.calls.errors, ['fetch refused', 'bunny delete 500']);
});
