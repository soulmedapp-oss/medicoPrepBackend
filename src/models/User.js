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
    permissions: { type: [String], default: [] },
    admin_status: { type: String, default: 'active' },
    is_teacher: { type: Boolean, default: false },
    tests_taken: { type: Number, default: 0 },
    average_score: { type: Number, default: 0 },
    last_login_date: { type: Date },
  },
  { timestamps: { createdAt: 'created_date', updatedAt: 'updated_date' } }
);

module.exports = mongoose.model('User', userSchema);
