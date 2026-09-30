// WebVTT / SRT → plain text, for the AI summary/chat and search. Cue numbers,
// timestamps, the WEBVTT header and NOTE blocks are dropped; cue text lines
// are joined with single spaces.
function transcriptToPlainText(raw) {
  return String(raw || '')
    .replace(/﻿/g, '')
    .replace(/\r/g, '')
    .split('\n')
    .filter((line) => !/^WEBVTT/.test(line))
    .filter((line) => !/^NOTE(\s|$)/.test(line))
    .filter((line) => !/^\d+\s*$/.test(line))
    .filter((line) => !/\d{1,2}:\d{2}(:\d{2})?[.,]\d{1,3}\s*-->/.test(line))
    .map((line) => line.replace(/<[^>]+>/g, '').trim())
    .filter(Boolean)
    .join(' ');
}

module.exports = { transcriptToPlainText };
