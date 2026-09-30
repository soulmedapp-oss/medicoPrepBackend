const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { ingestZoomRecording, pickTranscript, recordingLectureTitle } = require('../src/services/classRecordingIngest');
const { transcriptToPlainText } = require('../src/utils/transcriptText');

const oid = () => new mongoose.Types.ObjectId();
const VTT = 'WEBVTT\n\n1\n00:00:01.000 --> 00:00:03.000\nHello <v Dr Rao>everyone</v>\n\n2\n00:00:03.000 --> 00:00:05.000\nToday: the nephron.\n';

function deps(overrides = {}) {
  const calls = { downloads: [], stored: [], created: [], fetched: [], videoCreates: [], classUpdates: [], errors: [] };
  const d = {
    calls,
    pickRecording: (files) => files.find((f) => f.file_type === 'MP4') || null,
    downloadRecordingFile: async (file) => { calls.downloads.push(file); return Buffer.from(VTT); },
    tokenedDownloadUrl: async (url) => `${url}?access_token=T`,
    storeUpload: async (file, validated, folder) => { calls.stored.push({ name: file.originalname, folder, ext: validated.ext }); return `https://bucket/${folder}/x.vtt`; },
    createUpload: async ({ title, subject }) => { calls.created.push({ title, subject }); return { videoId: 'bunny-1', libraryId: 'lib-1' }; },
    fetchFromUrl: async (videoId, url) => { calls.fetched.push({ videoId, url }); },
    Video: { create: async (doc) => { calls.videoCreates.push(doc); return { _id: oid(), ...doc }; } },
    LiveClass: { updateOne: async (filter, update) => { calls.classUpdates.push(update); } },
    logger: { child: () => ({ info: () => {} }) },
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
const liveClass = () => ({
  _id: oid(), title: 'Renal physiology', subject: 'Physiology', subject_id: oid(), teacher_name: 'Dr Rao', teacher_email: 'rao@x.com',
  scheduled_date: new Date('2026-09-30T04:30:00Z'), zoom_recording_files: files, transcript_text: '', created_by: oid(),
});

test('transcriptToPlainText drops headers, numbers, timestamps, NOTE blocks and tags', () => {
  assert.equal(transcriptToPlainText(VTT), 'Hello everyone Today: the nephron.');
  assert.equal(transcriptToPlainText('NOTE hi\n\n00:01,000 --> 00:02,000\nA\n'), 'A');
});

test('pickTranscript / recordingLectureTitle', () => {
  assert.equal(pickTranscript(files).download_url, 'https://zoom/rec.vtt');
  assert.equal(pickTranscript([]), null);
  assert.equal(recordingLectureTitle(liveClass()), 'Renal physiology (2026-09-30) — recording');
});

test('ingest: stores the transcript, hands the MP4 to Bunny, creates a linked lecture, links the class', async () => {
  const d = deps();
  const lc = liveClass();
  const result = await ingestZoomRecording(lc, d);
  assert.deepEqual([result.transcript, result.video], ['stored', 'created']);
  assert.equal(d.calls.downloads[0].file_type, 'TRANSCRIPT', 'only the transcript is downloaded by us');
  assert.deepEqual(d.calls.stored[0], { name: 'Renal physiology.vtt', folder: 'transcripts/classes', ext: 'vtt' });
  assert.deepEqual(d.calls.classUpdates[0], { $set: { transcript_url: 'https://bucket/transcripts/classes/x.vtt', transcript_text: 'Hello everyone Today: the nephron.' } });
  assert.deepEqual(d.calls.created[0], { title: 'Renal physiology (2026-09-30) — recording', subject: 'Physiology' });
  assert.deepEqual(d.calls.fetched[0], { videoId: 'bunny-1', url: 'https://zoom/rec.mp4?access_token=T' }, 'Bunny fetches the MP4 from Zoom with the token');
  const created = d.calls.videoCreates[0];
  assert.equal(created.provider, 'bunny');
  assert.equal(created.bunny_video_id, 'bunny-1');
  assert.equal(created.processing_status, 'processing');
  assert.equal(String(created.source_live_class_id), String(lc._id));
  assert.equal(created.transcript_text, 'Hello everyone Today: the nephron.', 'the lecture gets the transcript too');
  assert.equal(String(d.calls.classUpdates[1].$set.recording_video_id), String(result.lectureId));
  assert.deepEqual(d.calls.errors, []);
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
});

test('ingest: no transcript file and no MP4 → nothing happens, nothing reported', async () => {
  const d = deps();
  const result = await ingestZoomRecording({ ...liveClass(), zoom_recording_files: [{ file_type: 'CHAT' }] }, d);
  assert.deepEqual([result.transcript, result.video], ['none', 'none']);
  assert.deepEqual(d.calls.errors, []);
});
