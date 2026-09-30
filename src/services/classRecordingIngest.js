// What happens when Zoom tells us a class recording is ready.
//
// 1. Claim: the webhook is answered before this runs (Zoom's delivery timeout
//    is short and a 200 it never sees becomes a redelivery), so two
//    deliveries can be in flight at once. A conditional findOneAndUpdate on
//    zoom_ingest_claimed_at being absent lets exactly one of them through.
// 2. Transcript: Zoom's TRANSCRIPT file (VTT) is downloaded with the
//    recording's download token, stored under transcripts/classes/ and
//    flattened into transcript_text so the AI summary / chat have something
//    to read.
// 3. Video: a Bunny Stream video is created and Bunny is asked to FETCH the
//    MP4 straight from Zoom (a tokened download URL) — nothing streams through
//    this server. A Lecture (Video document) is created for it, linked to the
//    class, so students watch it on the normal watch page and admins can put
//    it in playlists from the Lecture Library.
//
// Idempotent: a re-delivered webhook does not create a second lecture or
// overwrite a transcript an admin already uploaded. Every step logs and
// continues on failure; the webhook itself never fails because of this. When a
// step DID fail the claim is released again, so the next delivery retries it —
// the per-step guards (transcript_text non-empty / recording_video_id set)
// keep the step that already succeeded from being redone.
const mongoose = require('mongoose');
const { transcriptToPlainText } = require('../utils/transcriptText');
const { subjectWriteFields } = require('../utils/subjectResolution');
const { UPLOAD_FOLDERS } = require('../lib/uploadStorage');

const TRANSCRIPT_MAX = 200000; // matches the transcript_text validator

function pickTranscript(files = []) {
  return (files || []).find((f) => f && f.file_type === 'TRANSCRIPT') || null;
}

// Only a real MP4 is ever handed to Bunny. zoomService.pickRecording falls
// back to files[0] for the controller's recording_url, which is harmless for a
// link but not here: an M4A-only recording set would have us ask Bunny to
// encode an audio file as a lecture. No MP4 means no lecture.
function pickMp4(files = []) {
  return (files || []).find((f) => f && f.file_type === 'MP4') || null;
}

function recordingLectureTitle(liveClass) {
  const when = liveClass.scheduled_date ? new Date(liveClass.scheduled_date) : null;
  const day = when && !Number.isNaN(when.getTime()) ? when.toISOString().slice(0, 10) : '';
  return `${liveClass.title || 'Live class'}${day ? ` (${day})` : ''} — recording`;
}

/**
 * @param liveClass  lean LiveClass document (after the webhook's own $set)
 * @param deps       { downloadRecordingFile(file, { token }) → Buffer,
 *                     tokenedDownloadUrl(url, { token }) → Promise<string>,
 *                     storeUpload(file, validated, folder),
 *                     createUpload({title, subject}) → {videoId, libraryId},
 *                     fetchFromUrl(videoId, url), deleteVideo(videoId),
 *                     resolveSubjectForWrite(name) → {_id, name}|null,
 *                     Video, LiveClass, logger, reportError, downloadToken }
 * @returns { transcript: 'stored'|'skipped'|'none'|'failed', video: 'created'|'skipped'|'none'|'failed', lectureId, reason? }
 */
async function ingestZoomRecording(liveClass, deps) {
  const {
    downloadRecordingFile, tokenedDownloadUrl, storeUpload,
    createUpload, fetchFromUrl, deleteVideo, resolveSubjectForWrite,
    Video, LiveClass, logger, reportError, downloadToken,
  } = deps;
  const result = { transcript: 'none', video: 'none', lectureId: liveClass.recording_video_id || null };
  const files = liveClass.zoom_recording_files || [];
  const log = logger?.child ? logger.child({ liveClassId: String(liveClass._id) }) : logger;

  // --- 0. claim. Exactly one concurrent delivery gets past this.
  const claimed = await LiveClass.findOneAndUpdate(
    { _id: liveClass._id, zoom_ingest_claimed_at: { $exists: false } },
    { $set: { zoom_ingest_claimed_at: new Date() } }
  );
  if (!claimed) {
    return { transcript: 'skipped', video: 'skipped', lectureId: result.lectureId, reason: 'claimed' };
  }

  // --- 1. transcript
  let transcriptText = liveClass.transcript_text || '';
  const transcriptFile = pickTranscript(files);
  if (transcriptText) {
    result.transcript = 'skipped';
  } else if (transcriptFile) {
    try {
      const buffer = await downloadRecordingFile(transcriptFile, { token: downloadToken });
      const raw = buffer.toString('utf8');
      transcriptText = transcriptToPlainText(raw).slice(0, TRANSCRIPT_MAX);
      const stored = await storeUpload(
        { buffer, originalname: `${liveClass.title || 'class'}.vtt` },
        { ext: 'vtt', contentType: 'text/vtt; charset=utf-8' },
        UPLOAD_FOLDERS.classTranscript
      );
      await LiveClass.updateOne({ _id: liveClass._id }, { $set: { transcript_url: stored, transcript_text: transcriptText } });
      result.transcript = 'stored';
      log?.info?.({ bytes: buffer.length }, 'zoom transcript stored');
    } catch (err) {
      result.transcript = 'failed';
      reportError(null, err, 'zoom transcript ingest failed', { liveClassId: String(liveClass._id) });
    }
  }

  // --- 2. recording → Bunny → lecture
  const mp4 = pickMp4(files);
  if (liveClass.recording_video_id) {
    result.video = 'skipped';
  } else if (mp4 && mp4.download_url) {
    // Created inside the try so the catch can clean up the Bunny video when a
    // later step fails — an abandoned Bunny video keeps encoding and gets
    // billed with nothing pointing at it.
    let bunnyVideoId = null;
    try {
      const title = recordingLectureTitle(liveClass);
      // LiveClass stores only the subject name. Resolve it the same way
      // videosController.createVideo does so the lecture lands in the library
      // with a real subject_id; an unresolvable/inactive name is not fatal
      // here (the recording still matters), it just leaves subject_id unset.
      const subjectName = liveClass.subject || 'General';
      let subjectFields = { subject: subjectName };
      if (resolveSubjectForWrite) {
        try {
          const resolvedSubject = await resolveSubjectForWrite(subjectName);
          subjectFields = { subject: subjectName, ...subjectWriteFields(resolvedSubject) };
        } catch (err) {
          log?.warn?.({ err: err.message, subject: subjectName }, 'zoom recording lecture: subject not resolved');
        }
      }
      const lectureId = new mongoose.Types.ObjectId();
      const { videoId, libraryId } = await createUpload({ title, subject: liveClass.subject });
      bunnyVideoId = videoId;
      await fetchFromUrl(videoId, await tokenedDownloadUrl(mp4.download_url, { token: downloadToken }));
      const lecture = await Video.create({
        _id: lectureId,
        title,
        ...subjectFields,
        teacher_name: liveClass.teacher_name || 'Teacher',
        teacher_email: liveClass.teacher_email || undefined,
        provider: 'bunny',
        bunny_video_id: videoId,
        bunny_library_id: libraryId,
        processing_status: 'processing',
        transcript_text: transcriptText || '',
        source_live_class_id: liveClass._id,
        is_active: true,
        created_by: liveClass.created_by || undefined,
      });
      await LiveClass.updateOne({ _id: liveClass._id }, { $set: { recording_video_id: lectureId } });
      result.video = 'created';
      result.lectureId = lecture?._id || lectureId;
      log?.info?.({ lectureId: String(lectureId), bunnyVideoId: videoId }, 'zoom recording handed to Bunny');
    } catch (err) {
      result.video = 'failed';
      reportError(null, err, 'zoom recording ingest failed', { liveClassId: String(liveClass._id) });
      if (bunnyVideoId && deleteVideo) {
        try {
          await deleteVideo(bunnyVideoId);
        } catch (cleanupErr) {
          reportError(null, cleanupErr, 'zoom recording ingest: orphan Bunny video not removed', {
            liveClassId: String(liveClass._id),
            bunnyVideoId,
          });
        }
      }
    }
  }

  // Release the claim when a step failed, so the next delivery may retry it.
  if (result.transcript === 'failed' || result.video === 'failed') {
    try {
      await LiveClass.updateOne({ _id: liveClass._id }, { $unset: { zoom_ingest_claimed_at: '' } });
    } catch (err) {
      reportError(null, err, 'zoom recording ingest: claim not released', { liveClassId: String(liveClass._id) });
    }
  }

  return result;
}

module.exports = { ingestZoomRecording, pickTranscript, pickMp4, recordingLectureTitle };
