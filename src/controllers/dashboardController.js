const mongoose = require('mongoose');
const Doubt = require('../models/Doubt');
const LiveClass = require('../models/LiveClass');
const Subscription = require('../models/Subscription');
const Test = require('../models/Test');
const TestAttempt = require('../models/TestAttempt');
const User = require('../models/User');
const Payment = require('../models/Payment');

const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function startOfDay(date) {
  const next = new Date(date);
  next.setHours(0, 0, 0, 0);
  return next;
}

function endOfDay(date) {
  const next = new Date(date);
  next.setHours(23, 59, 59, 999);
  return next;
}

function toDateKey(date) {
  return date.toISOString().slice(0, 10);
}

async function buildDailyCounts(Model, match, dateField) {
  const today = startOfDay(new Date());
  const start = new Date(today);
  start.setDate(start.getDate() - 6);
  const end = endOfDay(new Date());

  const results = await Model.aggregate([
    { $match: { ...match, [dateField]: { $gte: start, $lte: end } } },
    {
      $group: {
        _id: {
          $dateToString: { format: '%Y-%m-%d', date: `$${dateField}` },
        },
        count: { $sum: 1 },
      },
    },
  ]);

  const countsByDate = new Map(results.map((row) => [row._id, row.count]));
  return Array.from({ length: 7 }, (_, index) => {
    const day = new Date(start);
    day.setDate(start.getDate() + index);
    const key = toDateKey(day);
    return {
      date: DAY_LABELS[day.getDay()],
      count: countsByDate.get(key) || 0,
    };
  });
}

function createDashboardController() {
  async function getAdminDashboard(req, res) {
    try {
      const user = await User.findById(req.userId).lean();
      if (!user) {
        return res.status(404).json({ error: 'User not found' });
      }
      const hasAdminRole = user.role === 'admin' || (Array.isArray(user.roles) && user.roles.includes('admin'));
      if (!hasAdminRole) {
        return res.status(403).json({ error: 'Admin access required' });
      }

      const totalStudents = await User.countDocuments({
        role: { $nin: ['admin', 'teacher'] },
        is_teacher: { $ne: true },
      });
      const activeSubscribers = await Subscription.countDocuments({
        status: 'active',
        plan: { $ne: 'free' },
      });
      const totalTests = await Test.countDocuments({});
      const publishedTests = await Test.countDocuments({ is_published: true });
      const pendingDoubts = await Doubt.countDocuments({ status: 'pending' });
      const totalClasses = await LiveClass.countDocuments({});

      const now = new Date();
      const todayStart = startOfDay(now);
      const todayEnd = endOfDay(now);
      const weekStart = new Date(todayStart);
      weekStart.setDate(weekStart.getDate() - 6);
      const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
      const activeWindow = new Date(now.getTime() - 10 * 60 * 1000);

      const studentFilter = {
        role: { $nin: ['admin', 'teacher'] },
        is_teacher: { $ne: true },
      };

      const newStudentsToday = await User.countDocuments({
        ...studentFilter,
        created_date: { $gte: todayStart, $lte: todayEnd },
      });
      const newStudentsMonth = await User.countDocuments({
        ...studentFilter,
        created_date: { $gte: monthStart, $lte: todayEnd },
      });
      const activeUsersNow = await User.countDocuments({
        ...studentFilter,
        $or: [
          { last_seen_date: { $gte: activeWindow } },
          { last_login_date: { $gte: activeWindow } },
        ],
      });
      const activeUsersWeek = await User.countDocuments({
        ...studentFilter,
        $or: [
          { last_seen_date: { $gte: weekStart, $lte: todayEnd } },
          { last_login_date: { $gte: weekStart, $lte: todayEnd } },
        ],
      });
      const activeUsersMonth = await User.countDocuments({
        ...studentFilter,
        $or: [
          { last_seen_date: { $gte: monthStart, $lte: todayEnd } },
          { last_login_date: { $gte: monthStart, $lte: todayEnd } },
        ],
      });
      const dau = await User.countDocuments({
        ...studentFilter,
        $or: [
          { last_seen_date: { $gte: todayStart, $lte: todayEnd } },
          { last_login_date: { $gte: todayStart, $lte: todayEnd } },
        ],
      });
      const mau = activeUsersMonth;
      const dauMauRatio = mau ? Math.round((dau / mau) * 1000) / 10 : 0;

      const testsToday = await TestAttempt.countDocuments({
        status: 'completed',
        created_date: { $gte: todayStart, $lte: todayEnd },
      });
      const testsWeek = await TestAttempt.countDocuments({
        status: 'completed',
        created_date: { $gte: weekStart, $lte: todayEnd },
      });

      const paidTodayAgg = await Payment.aggregate([
        {
          $match: {
            status: 'paid',
            subscription_activated: true,
            paid_at: { $gte: todayStart, $lte: todayEnd },
          },
        },
        { $group: { _id: '$user_id' } },
        { $count: 'total' },
      ]);
      const paidSubscribersToday = paidTodayAgg[0]?.total || 0;

      const subscriptionDistributionRaw = await Subscription.aggregate([
        { $group: { _id: '$plan', value: { $sum: 1 } } },
      ]);
      const subscriptionDistribution = subscriptionDistributionRaw.map((row) => ({
        name: row._id ? String(row._id).charAt(0).toUpperCase() + String(row._id).slice(1) : 'Unknown',
        value: row.value,
      }));

      const dailyRegistrations = await buildDailyCounts(User, {}, 'created_date');
      const dailyAttempts = await buildDailyCounts(TestAttempt, {}, 'created_date');

      const recentDoubtsRaw = await Doubt.find({})
        .sort({ created_date: -1 })
        .limit(20)
        .select('topic subject student_name status created_date')
        .lean();
      const recentDoubts = recentDoubtsRaw.map((doubt) => ({
        ...doubt,
        id: String(doubt._id),
      }));

      const recentAttemptsRaw = await TestAttempt.find({ status: 'completed' })
        .sort({ created_date: -1 })
        .limit(20)
        .select('user_name percentage created_date')
        .lean();
      const recentAttempts = recentAttemptsRaw.map((attempt) => ({
        ...attempt,
        id: String(attempt._id),
      }));

      return res.json({
        stats: {
          total_students: totalStudents,
          active_subscribers: activeSubscribers,
          total_tests: totalTests,
          published_tests: publishedTests,
          pending_doubts: pendingDoubts,
          total_classes: totalClasses,
          new_students_today: newStudentsToday,
          new_students_month: newStudentsMonth,
          active_users_now: activeUsersNow,
          active_users_week: activeUsersWeek,
          active_users_month: activeUsersMonth,
          dau_mau_ratio: dauMauRatio,
          tests_today: testsToday,
          tests_week: testsWeek,
          paid_subscribers_today: paidSubscribersToday,
        },
        charts: {
          daily_registrations: dailyRegistrations,
          daily_attempts: dailyAttempts,
          subscription_distribution: subscriptionDistribution,
        },
        recent: {
          doubts: recentDoubts,
          attempts: recentAttempts,
        },
      });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: 'Failed to load admin dashboard' });
    }
  }

  async function getStudentDashboard(req, res) {
    try {
      const userId = new mongoose.Types.ObjectId(req.userId);

      const attemptSummary = await TestAttempt.aggregate([
        { $match: { user_id: userId, status: 'completed' } },
        {
          $group: {
            _id: null,
            count: { $sum: 1 },
            avgPercentage: { $avg: '$percentage' },
          },
        },
      ]);
      const completedTests = attemptSummary[0]?.count || 0;
      const avgScore = attemptSummary[0]?.avgPercentage || 0;

      const pendingDoubts = await Doubt.countDocuments({
        student_id: userId,
        status: 'pending',
      });

      const todayStart = startOfDay(new Date());
      const todayEnd = endOfDay(new Date());

      const classesToday = await LiveClass.countDocuments({
        is_published: true,
        status: 'scheduled',
        scheduled_date: { $gte: todayStart, $lte: todayEnd },
      });

      const bestAttempt = await TestAttempt.findOne({ user_id: userId, status: 'completed' })
        .sort({ percentage: -1, created_date: -1 })
        .select('percentage created_date')
        .lean();

      const dailyAttempts = await TestAttempt.find({
        user_id: userId,
        status: 'completed',
        created_date: { $gte: todayStart, $lte: todayEnd },
      })
        .sort({ created_date: -1 })
        .select('percentage created_date answers')
        .lean();

      const latestAttempt = await TestAttempt.findOne({ user_id: userId, status: 'completed' })
        .sort({ completed_at: -1, created_date: -1 })
        .select('percentage created_date answers')
        .lean();

      let microWin = null;
      if (dailyAttempts.length > 0 && latestAttempt) {
        const correctCount = (latestAttempt.answers || []).filter((answer) => answer.is_correct).length;
        const totalQuestions = latestAttempt.answers?.length || 0;
        const accuracyPercent = totalQuestions > 0
          ? Math.round((correctCount / totalQuestions) * 100)
          : null;
        const isPersonalBest =
          bestAttempt &&
          Number.isFinite(Number(bestAttempt.percentage)) &&
          Number(bestAttempt.percentage) === Number(latestAttempt.percentage);

        if (isPersonalBest) {
          microWin = {
            type: 'personal_best',
            title: 'New personal best!',
            message: `You scored ${Number(latestAttempt.percentage || 0).toFixed(1)}% today.`,
            progress: Number(latestAttempt.percentage || 0),
            progress_label: 'Best score',
          };
        } else if (dailyAttempts.length >= 2) {
          microWin = {
            type: 'daily_practice',
            title: 'Practice streak!',
            message: `You completed ${dailyAttempts.length} tests today.`,
          };
        } else if (accuracyPercent !== null) {
          microWin = {
            type: 'accuracy_boost',
            title: 'Accuracy boost!',
            message: `You got ${correctCount}/${totalQuestions} correct in your last test.`,
            progress: accuracyPercent,
            progress_label: 'Accuracy',
          };
        } else {
          microWin = {
            type: 'daily_win',
            title: 'Nice work!',
            message: 'You completed a test today. Keep going!',
          };
        }
      }

      const upcomingClassesRaw = await LiveClass.find({
        is_published: true,
        status: 'scheduled',
        scheduled_date: { $gte: new Date() },
      })
        .sort({ scheduled_date: 1 })
        .limit(3)
        .select([
          'title',
          'description',
          'topic_covered',
          'subject',
          'teacher_name',
          'scheduled_date',
          'duration_minutes',
          'meeting_link',
          'youtube_url',
          'recording_url',
          'thumbnail_url',
          'status',
          'is_free',
          'allowed_plans',
          'zoom_recording_started_at',
        ])
        .lean();
      const upcomingClasses = upcomingClassesRaw.map((liveClass) => ({
        ...liveClass,
        id: String(liveClass._id),
      }));

      const recentAttemptsRaw = await TestAttempt.aggregate([
        { $match: { user_id: userId, status: 'completed' } },
        { $sort: { created_date: -1 } },
        { $limit: 5 },
        {
          $lookup: {
            from: 'tests',
            localField: 'test_id',
            foreignField: '_id',
            as: 'test',
          },
        },
        { $unwind: { path: '$test', preserveNullAndEmptyArrays: true } },
        {
          $project: {
            _id: 1,
            test_id: 1,
            percentage: 1,
            score: 1,
            total_marks: 1,
            created_date: 1,
            test_title: '$test.title',
            test_subject: '$test.subject',
            test_total_marks: '$test.total_marks',
            test_required_plan: '$test.required_plan',
          },
        },
      ]);
      const recentAttempts = recentAttemptsRaw.map((attempt) => ({
        ...attempt,
        id: String(attempt._id),
      }));

      const subjectProgressRaw = await TestAttempt.aggregate([
        { $match: { user_id: userId, status: 'completed' } },
        {
          $lookup: {
            from: 'tests',
            localField: 'test_id',
            foreignField: '_id',
            as: 'test',
          },
        },
        { $unwind: { path: '$test', preserveNullAndEmptyArrays: false } },
        {
          $group: {
            _id: '$test.subject',
            average: { $avg: '$percentage' },
          },
        },
        { $sort: { average: -1 } },
        { $limit: 4 },
      ]);
      const subjectProgress = subjectProgressRaw.map((item) => ({
        subject: item._id,
        average: Math.round(item.average || 0),
      }));

      return res.json({
        stats: {
          completed_tests: completedTests,
          avg_score: Math.round(avgScore * 10) / 10,
          pending_doubts: pendingDoubts,
          classes_today: classesToday,
          personal_best_score: bestAttempt?.percentage || 0,
          personal_best_date: bestAttempt?.created_date || null,
        },
        upcoming_classes: upcomingClasses,
        recent_attempts: recentAttempts,
        subject_progress: subjectProgress,
        micro_win: microWin,
      });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: 'Failed to load student dashboard' });
    }
  }

  return { getAdminDashboard, getStudentDashboard };
}

module.exports = { createDashboardController };
