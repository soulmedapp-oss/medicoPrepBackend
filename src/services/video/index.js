const bunnyProvider = require('./bunnyProvider');

// `youtube` rows have no hosted asset: playback is the stored URL.
const youtubeProvider = {
  getPlaybackToken: (video) => ({ hls_url: '', token: '', expires_at: 0, video_url: video.video_url }),
};

function getProvider(name) {
  return name === 'bunny' ? bunnyProvider : youtubeProvider;
}

module.exports = { getProvider };
