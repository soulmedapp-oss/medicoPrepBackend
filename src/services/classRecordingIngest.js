// What happens when Zoom tells us a class recording is ready.
//
// 1. Transcript: Zoom's TRANSCRIPT file (VTT) is downloaded with our Zoom
//    token, stored under transcripts/classes/ and flattened into
//    transcript_text so the AI summary / chat have something to read.
// 2. Video: a Bunny Stream video is created and Bunny is asked to FETCH the
//    MP4 straight from Zoom (a tokened download URL) — nothing streams through
//    this server. A Lecture (Video document) is created for it, linked to the
//    class, so students watch it on the normal watch page and admins can put
//    it in playlists from the Lecture Library.
//
// Idempotent: a re-delivered webhook does not create a second lecture or
// overwrite a transcript an admin already uploaded. Every step logs and
// continues on failure; the webhook itself never fails because of this.
const { transcriptToPlainText } = require('../utils/transcriptText');
const { UPLOAD_FOLDERS } = require('../lib/uploadStorage');

const TRANSCRIPT_MAX = 200000; // matches the transcript_text validator

function pickTranscript(files = []) {
  return (files || []).find((f) => f && f.file_type === 'TRANSCRIPT') || null;
}

function recordingLectureTitle(liveClass) {
  const when = liveClass.scheduled_date ? new Date(liveClass.scheduled_date) : null;
  const day = when && !Number.isNaN(when.getTime()) ? when.toISOString().slice(0, 10) : '';
  return `${liveClass.title || 'Live class'}${day ? ` (${day})` : ''} — recording`;
}

/**
 * @param liveClass  lean LiveClass document (after the webhook's own $set)
 * @param deps       { pickRecording, downloadRecordingFile(file) → Buffer,
 *                     tokenedDownloadUrl(url) → Promise<string>, storeUpload(file, validated, folder),
 *                     createUpload({title, subject}) → {videoId, libraryId},
 *                     fetchFromUrl(videoId, url), Video, LiveClass, logger, reportError }
 * @returns { transcript: 'stored'|'skipped'|'none'|'failed', video: 'created'|'skipped'|'none'|'failed', lectureId }
 */
async function ingestZoomRecording(liveClass, deps) {
  const {
    pickRecording, downloadRecordingFile, tokenedDownloadUrl, storeUpload,
    createUpload, fetchFromUrl, Video, LiveClass, logger, reportError,
  } = deps;
  const result = { transcript: 'none', video: 'none', lectureId: liveClass.recording_video_id || null };
  const files = liveClass.zoom_recording_files || [];
  const log = logger?.child ? logger.child({ liveClassId: String(liveClass._id) }) : logger;

  // --- 1. transcript
  let transcriptText = liveClass.transcript_text || '';
  const transcriptFile = pickTranscript(files);
  if (transcriptText) {
    result.transcript = 'skipped';
  } else if (transcriptFile) {
    try {
      const buffer = await downloadRecordingFile(transcriptFile);
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
  const mp4 = pickRecording(files);
  if (liveClass.recording_video_id) {
    result.video = 'skipped';
  } else if (mp4 && mp4.download_url) {
    try {
      const title = recordingLectureTitle(liveClass);
      const { videoId, libraryId } = await createUpload({ title, subject: liveClass.subject });
      await fetchFromUrl(videoId, await tokenedDownloadUrl(mp4.download_url));
      const lecture = await Video.create({
        title,
        subject: liveClass.subject || 'General',
        subject_id: liveClass.subject_id || undefined,
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
      await LiveClass.updateOne({ _id: liveClass._id }, { $set: { recording_video_id: lecture._id } });
      result.video = 'created';
      result.lectureId = lecture._id;
      log?.info?.({ lectureId: String(lecture._id), bunnyVideoId: videoId }, 'zoom recording handed to Bunny');
    } catch (err) {
      result.video = 'failed';
      reportError(null, err, 'zoom recording ingest failed', { liveClassId: String(liveClass._id) });
    }
  }

  return result;
}

module.exports = { ingestZoomRecording, pickTranscript, recordingLectureTitle };
