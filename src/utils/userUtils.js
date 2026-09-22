function sanitizeUser(user) {
  if (!user) return null;
  const {
    passwordHash,
    __v,
    googleId,
    token_version,
    email_verification_token,
    email_verification_expires,
    email_verification_sent_at,
    password_reset_token,
    password_reset_expires,
    password_reset_requested_at,
    ...rest
  } = user.toObject ? user.toObject() : user;
  return rest;
}

function sanitizePublicUser(user) {
  const safeUser = sanitizeUser(user);
  if (!safeUser) return null;
  return {
    _id: safeUser._id,
    full_name: safeUser.full_name,
    email: safeUser.email,
    profile_image: safeUser.profile_image,
    role: safeUser.role,
    roles: safeUser.roles,
    is_teacher: Boolean(safeUser.is_teacher),
  };
}

module.exports = { sanitizeUser, sanitizePublicUser };
