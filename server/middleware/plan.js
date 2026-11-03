const { forbidden } = require('../errors');

/**
 * Plan feature gate (server-side; the UI only mirrors it).
 * `req.subscription` is loaded from the database on every request (middleware/session.js).
 *   - no subscription        → allowed (manually managed companies keep unlimited behaviour)
 *   - plan includes feature  → allowed
 *   - otherwise              → 403 plan.feature_unavailable
 * Inactive subscriptions are already limited separately by enforceSubscription().
 */
function planAllows(subscription, feature) {
  if (!subscription) return true;
  const features = Array.isArray(subscription.plan?.features) ? subscription.plan.features : [];
  return features.includes(feature);
}

const requirePlanFeature = feature => (req, _res, next) => {
  if (planAllows(req.subscription, feature)) return next();
  next(forbidden('plan.feature_unavailable', `Your plan does not include ${feature}`));
};

/** Feature list for the UI; null means "no subscription → everything currently available". */
const planFeaturesFor = subscription => (subscription ? (Array.isArray(subscription.plan?.features) ? subscription.plan.features : []) : null);

module.exports = { requirePlanFeature, planAllows, planFeaturesFor };
