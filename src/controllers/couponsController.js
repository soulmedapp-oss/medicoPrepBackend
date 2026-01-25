const Coupon = require('../models/Coupon');
const CouponRedemption = require('../models/CouponRedemption');
const SubscriptionPlan = require('../models/SubscriptionPlan');
const { isValidTextLength } = require('../utils/validation');

function percentDiscount(amount, percent) {
  const discount = Math.round((amount * percent) / 100);
  return Math.min(discount, amount);
}

function createCouponsController() {
  async function validateCoupon(req, res) {
    try {
      const { code, plan } = req.body || {};
      if (!code) {
        return res.status(400).json({ error: 'coupon code is required' });
      }
      const normalized = String(code).trim().toUpperCase();
      const coupon = await Coupon.findOne({ code: normalized, is_active: true }).lean();
      if (!coupon) {
        return res.status(404).json({ error: 'Invalid coupon code' });
      }
      if (coupon.expires_at && new Date(coupon.expires_at) < new Date()) {
        return res.status(400).json({ error: 'Coupon expired' });
      }
      if (coupon.max_uses_total && coupon.uses_total >= coupon.max_uses_total) {
        return res.status(400).json({ error: 'Coupon usage limit reached' });
      }
      const alreadyUsed = await CouponRedemption.findOne({
        coupon_code: coupon.code,
        user_id: req.userId,
      }).lean();
      if (alreadyUsed) {
        return res.status(400).json({ error: 'Coupon already used' });
      }
      const percent = Number(coupon.percent_off || 0);
      if (!percent || Number.isNaN(percent) || percent <= 0 || percent > 100) {
        return res.status(400).json({ error: 'Coupon is not valid' });
      }

      let baseAmount = null;
      let discountAmount = null;
      let finalAmount = null;
      if (plan) {
        const planDoc = await SubscriptionPlan.findOne({
          plan_name: String(plan).trim().toLowerCase(),
          is_active: true,
        }).lean();
        if (!planDoc) {
          return res.status(404).json({ error: 'Plan not available' });
        }
        baseAmount = Number(planDoc.price || 0);
        discountAmount = percentDiscount(baseAmount, percent);
        finalAmount = Math.max(0, baseAmount - discountAmount);
      }

      return res.json({
        valid: true,
        code: coupon.code,
        percent_off: percent,
        base_amount: baseAmount,
        discount_amount: discountAmount,
        final_amount: finalAmount,
      });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: 'Failed to validate coupon' });
    }
  }

  async function listCoupons(req, res) {
    try {
      const coupons = await Coupon.find({}).sort({ created_date: -1 }).lean();
      return res.json({ coupons });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: 'Failed to load coupons' });
    }
  }

  async function createCoupon(req, res) {
    try {
      const data = req.body || {};
      if (!data.code || !isValidTextLength(String(data.code), 3, 50)) {
        return res.status(400).json({ error: 'code is required' });
      }
      const percent = Number(data.percent_off || 0);
      if (!percent || Number.isNaN(percent) || percent <= 0 || percent > 100) {
        return res.status(400).json({ error: 'percent_off must be between 1 and 100' });
      }
      const coupon = await Coupon.create({
        code: String(data.code).trim().toUpperCase(),
        percent_off: percent,
        description: data.description || '',
        is_active: data.is_active !== false,
        max_uses_total: Number(data.max_uses_total || 0),
        max_uses_per_user: Number(data.max_uses_per_user || 1),
        expires_at: data.expires_at ? new Date(data.expires_at) : undefined,
      });
      return res.status(201).json({ coupon });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: 'Failed to create coupon' });
    }
  }

  async function updateCoupon(req, res) {
    try {
      const updates = req.body || {};
      if (updates.code) {
        updates.code = String(updates.code).trim().toUpperCase();
      }
      if (updates.percent_off !== undefined) {
        const percent = Number(updates.percent_off);
        if (Number.isNaN(percent) || percent <= 0 || percent > 100) {
          return res.status(400).json({ error: 'percent_off must be between 1 and 100' });
        }
        updates.percent_off = percent;
      }
      const coupon = await Coupon.findByIdAndUpdate(
        req.params.id,
        { $set: updates },
        { new: true }
      ).lean();
      if (!coupon) {
        return res.status(404).json({ error: 'Coupon not found' });
      }
      return res.json({ coupon });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: 'Failed to update coupon' });
    }
  }

  async function deleteCoupon(req, res) {
    try {
      const coupon = await Coupon.findById(req.params.id);
      if (!coupon) {
        return res.status(404).json({ error: 'Coupon not found' });
      }
      coupon.is_active = false;
      await coupon.save();
      return res.json({ ok: true, coupon: coupon.toObject() });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: 'Failed to deactivate coupon' });
    }
  }

  return { validateCoupon, listCoupons, createCoupon, updateCoupon, deleteCoupon };
}

module.exports = { createCouponsController };
