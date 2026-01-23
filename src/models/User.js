const mongoose = require('mongoose');

const userSchema = new mongoose.Schema(
  {
    googleId: { type: String, index: true, sparse: true },
    email: { type: String, required: true, unique: true, index: true },
    passwordHash: { type: String },
    full_name: { type: String, required: true },
    profile_image: { type: String },
    phone: { type: String },
    college: { type: String },
    year_of_study: { type: String },
    target_exam: { type: String },
    subscription_plan: { type: String, default: 'free' },
    role: { type: String, default: 'student' },
    roles: { type: [String], default: [] },
    permissions: { type: [String], default: [] },
    admin_status: { type: String, default: 'active' },
    is_teacher: { type: Boolean, default: false },
    tests_taken: { type: Number, default: 0 },
    average_score: { type: Number, default: 0 },
    last_login_date: { type: Date },
    last_login_ip: { type: String },
    last_login_city: { type: String },
    last_login_region: { type: String },
    last_login_country: { type: String },
    last_login_isp: { type: String },
    last_login_lat: { type: Number },
    last_login_lng: { type: Number },
    last_login_user_agent: { type: String },
    email_verified: { type: Boolean, default: false },
    email_verified_at: { type: Date },
    email_verification_token: { type: String },
    email_verification_expires: { type: Date },
    email_verification_sent_at: { type: Date },
    password_reset_token: { type: String },
    password_reset_expires: { type: Date },
    password_reset_requested_at: { type: Date },
    is_active: { type: Boolean, default: true },
  },
  { timestamps: { createdAt: 'created_date', updatedAt: 'updated_date' } }
);

module.exports = mongoose.model('User', userSchema);
