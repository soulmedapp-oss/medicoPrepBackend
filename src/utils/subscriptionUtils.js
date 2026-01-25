function computeSubscriptionEndDate(plan, startDate = new Date()) {
  if (!plan) return null;
  if (plan.is_lifetime) return null;
  const value = Number(plan.duration_value || 1);
  const unit = String(plan.duration_unit || 'months').toLowerCase();
  const endDate = new Date(startDate);
  if (unit === 'days') {
    endDate.setDate(endDate.getDate() + value);
    return endDate;
  }
  if (unit === 'years') {
    endDate.setFullYear(endDate.getFullYear() + value);
    return endDate;
  }
  endDate.setMonth(endDate.getMonth() + value);
  return endDate;
}

module.exports = { computeSubscriptionEndDate };
