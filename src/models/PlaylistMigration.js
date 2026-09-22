const mongoose = require('mongoose');

// The videos->playlists migration's own idempotency log (Task 7 fix round
// 1). Deliberately a separate collection rather than a marker on Playlist
// itself: a field or description string on Playlist is reachable — and
// therefore erasable or reinterpretable — from every present and future
// playlist-editing surface (Task 3's PATCH, Task 10's admin UI). This
// collection has no route and no controller pointed at it, so nothing but
// the migration script itself can ever write or clear a row here.
//
// Keyed on subject_id, not playlist_id: a curator broadening a migrated
// playlist's subject_ids (legitimate per Playlist.js's own comment — a
// playlist "may legitimately span subjects") must never make that playlist
// disappear from the migrated set. The unique index below is also the
// concurrency guard for a double --execute: two runs racing to migrate the
// same subject can both insert a Playlist, but only one PlaylistMigration
// row can exist per subject_id, so the loser's duplicate-key error is what
// tells the script to delete the orphan Playlist it just created.
const playlistMigrationSchema = new mongoose.Schema(
  {
    subject_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Subject', required: true },
    playlist_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Playlist', required: true },
    migrated_at: { type: Date, default: Date.now },
  },
  { timestamps: false }
);

playlistMigrationSchema.index({ subject_id: 1 }, { unique: true });

module.exports = mongoose.model('PlaylistMigration', playlistMigrationSchema);
