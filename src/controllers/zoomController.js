const LiveClass = require('../models/LiveClass');
const { reportError } = require('../lib/errorReporter.js');
const Video = require('../models/Video');
const { logger } = require('../lib/logger');
const {
  verifyZoomWebhookSignature,
  buildZoomValidationResponse,
  pickRecording,
  tokenedDownloadUrl,
  downloadRecordingFile,
} = require('../services/zoomService');
const { createUpload, fetchFromUrl } = require('../services/video/bunnyProvider');
const { getDefaultStorage } = require('../lib/uploadStorage');
const { ingestZoomRecording } = require('../services/classRecordingIngest');

async function handleZoomWebhook(req, res) {
  try {
    const rawBody = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '';
    if (!rawBody) {
      return res.status(400).json({ error: 'Missing body' });
    }

    let payload;
    try {
      payload = JSON.parse(rawBody);
    } catch (err) {
      return res.status(400).json({ error: 'Invalid JSON' });
    }

    if (payload?.event === 'endpoint.url_validation') {
      const plainToken = payload?.payload?.plainToken;
      if (!plainToken) {
        return res.status(400).json({ error: 'Missing plainToken' });
      }
      return res.json(buildZoomValidationResponse(plainToken));
    }

    if (!verifyZoomWebhookSignature(rawBody, req.headers)) {
      return res.status(401).json({ error: 'Invalid signature' });
    }

    if (payload?.event === 'meeting.ended') {
      const meeting = payload?.payload?.object || {};
      const meetingId = meeting?.id ? String(meeting.id) : '';
      const meetingUuid = meeting?.uuid ? String(meeting.uuid) : '';
      const update = { status: 'completed' };
      const byMeetingId = meetingId
        ? await LiveClass.findOneAndUpdate({ zoom_meeting_id: meetingId }, { $set: update }, { new: true })
        : null;
      if (!byMeetingId && meetingUuid) {
        await LiveClass.findOneAndUpdate({ zoom_meeting_uuid: meetingUuid }, { $set: update });
      }
    }

    if (payload?.event === 'recording.started') {
      const meeting = payload?.payload?.object || {};
      const meetingId = meeting?.id ? String(meeting.id) : '';
      const meetingUuid = meeting?.uuid ? String(meeting.uuid) : '';
      const update = {
        zoom_meeting_id: meetingId || undefined,
        zoom_meeting_uuid: meetingUuid || undefined,
        zoom_recording_started_at: meeting?.recording_start || meeting?.start_time || new Date().toISOString(),
      };
      const byMeetingId = meetingId
        ? await LiveClass.findOneAndUpdate({ zoom_meeting_id: meetingId }, { $set: update }, { new: true })
        : null;
      if (!byMeetingId && meetingUuid) {
        await LiveClass.findOneAndUpdate({ zoom_meeting_uuid: meetingUuid }, { $set: update });
      }
    }

    if (payload?.event === 'recording.completed') {
      const meeting = payload?.payload?.object || {};
      const meetingId = meeting?.id ? String(meeting.id) : '';
      const meetingUuid = meeting?.uuid ? String(meeting.uuid) : '';
      const recordingFiles = meeting?.recording_files || [];
      const picked = pickRecording(recordingFiles);
      const recordingUrl = picked?.play_url || picked?.download_url || '';

      const update = {
        zoom_meeting_id: meetingId || undefined,
        zoom_meeting_uuid: meetingUuid || undefined,
        zoom_recording_files: recordingFiles,
        zoom_recording_completed_at: meeting?.recording_end || meeting?.end_time || new Date().toISOString(),
        zoom_recording_password: meeting?.recording_password || '',
        recording_url: recordingUrl || undefined,
        status: 'completed',
      };

      const byMeetingId = meetingId
        ? await LiveClass.findOneAndUpdate({ zoom_meeting_id: meetingId }, { $set: update }, { new: true }).lean()
        : null;
      const byUuid = !byMeetingId && meetingUuid
        ? await LiveClass.findOneAndUpdate({ zoom_meeting_uuid: meetingUuid }, { $set: update }, { new: true }).lean()
        : null;
      const liveClass = byMeetingId || byUuid;

      // Transcript + Bunny copy. Best effort: logs and continues, never fails
      // the webhook (Zoom would only retry and we would redo the same work).
      if (liveClass) {
        try {
          await ingestZoomRecording(liveClass, {
            pickRecording,
            downloadRecordingFile,
            tokenedDownloadUrl,
            storeUpload: (file, validated, folder) => getDefaultStorage().storeUpload(file, validated, folder),
            createUpload,
            fetchFromUrl,
            Video,
            LiveClass,
            logger,
            reportError,
          });
        } catch (err) {
          reportError(req, err, 'zoom recording ingest crashed');
        }
      }
    }

    return res.json({ ok: true });
  } catch (err) {
    reportError(req, err, 'Zoom webhook error');
    return res.status(500).json({ error: 'Webhook processing failed' });
  }
}

module.exports = { handleZoomWebhook };
