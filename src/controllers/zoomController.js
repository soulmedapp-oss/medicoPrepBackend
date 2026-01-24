const LiveClass = require('../models/LiveClass');
const {
  verifyZoomWebhookSignature,
  buildZoomValidationResponse,
  pickRecording,
} = require('../services/zoomService');

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
        ? await LiveClass.findOneAndUpdate({ zoom_meeting_id: meetingId }, { $set: update }, { new: true })
        : null;
      if (!byMeetingId && meetingUuid) {
        await LiveClass.findOneAndUpdate({ zoom_meeting_uuid: meetingUuid }, { $set: update });
      }
    }

    return res.json({ ok: true });
  } catch (err) {
    console.error('Zoom webhook error:', err);
    return res.status(500).json({ error: 'Webhook processing failed' });
  }
}

module.exports = { handleZoomWebhook };
