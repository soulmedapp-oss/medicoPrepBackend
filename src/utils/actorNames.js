// Pure: given a staff-path page of lean documents (videos, classes, ...) and a
// Map of userId string -> user doc ({ _id, full_name }), returns new objects
// carrying three flat fields for the admin UI — created_by_name,
// updated_by_name and updated_by_at (passed through as-is). Never mutates the
// input documents. A missing/deleted user (absent from the map) yields null
// rather than throwing, and only _id/full_name ever reach the output — no
// email, no other user field.
//
// Shared by videosController.listVideos and classesController.listClasses
// (staff `all=true` branch) — moved out of videosController so classes can
// reuse the identical enrichment instead of growing a second copy.
function attachActorNames(docs, userMap) {
  const nameFor = (id) => {
    if (!id) return null;
    const user = userMap instanceof Map ? userMap.get(String(id)) : undefined;
    return user && user.full_name ? user.full_name : null;
  };
  return docs.map((doc) => ({
    ...doc,
    created_by_name: nameFor(doc.created_by),
    updated_by_name: nameFor(doc.updated_by),
    updated_by_at: doc.updated_by_at || null,
  }));
}

module.exports = { attachActorNames };
