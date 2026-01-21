function sanitizeUser(user) {
  if (!user) return null;
  const {
    passwordHash,
    __v,
    email_verification_token,
    email_verification_expires,
    password_reset_token,
    password_reset_expires,
    ...rest
  } = user.toObject ? user.toObject() : user;
  return rest;
}

module.exports = { sanitizeUser };
