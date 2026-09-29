const mongoose = require('mongoose');

const subscriptionPlanSchema = new mongoose.Schema(
  {
    plan_name: { type: String, required: true, unique: true, index: true },
    display_name: { type: String, required: true },
    description: { type: String, default: '' },
    price: { type: Number, default: 0 },
    video_hours: { type: Number, default: 0 },
    live_classes_per_month: { type: String, default: '0' },
    practice_questions: { type: String, default: '0' },
    notes_access: { type: Boolean, default: false },
    doubt_support: { type: String, default: 'none' },
    support_response_time: { type: String, default: '' },
    mock_tests: { type: Boolean, default: false },
    performance_analytics: { type: Boolean, default: false },
    study_plan: { type: Boolean, default: false },
    mentoring_sessions: { type: String, default: '0' },
    career_counseling: { type: Boolean, default: false },
    is_popular: { type: Boolean, default: false },
    is_active: { type: Boolean, default: true },
    sort_order: { type: Number, default: 0 },
    duration_value: { type: Number, default: 1 },
    duration_unit: { type: String, default: 'months' },
    is_lifetime: { type: Boolean, default: false },
    // Entitlement order (spec §4): a student whose plan tier is >= an item's
    // required tier may open it. Free = 0. Set by the admin; backfilled from
    // sort_order once by ensurePlanTiers() in server.js.
    tier: { type: Number, default: 0, min: 0 },
    // Copy for the student Upgrade dialog when this plan is the cheapest way
    // into a locked item.
    pitch: {
      headline: { type: String, default: '' },
      highlights: { type: [{ icon: { type: String }, text: { type: String }, _id: false }], default: [] },
      banner_url: { type: String, default: '' },
    },
  },
  { timestamps: { createdAt: 'created_date', updatedAt: 'updated_date' } }
);

module.exports = mongoose.model('SubscriptionPlan', subscriptionPlanSchema);
