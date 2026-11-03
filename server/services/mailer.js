/**
 * Outgoing email. Drivers:
 *   none   – no email is sent; invitation/reset links are shown once to the admin who created them.
 *   smtp   – any SMTP provider (SES, Resend, Postmark, Mailgun, Gmail…) via SMTP_* settings.
 *   memory – used by tests; keeps messages in `outbox`.
 * Message bodies are plain, short and bilingual-ready; never include secrets other than the one-time link.
 */
function createMailer(mailConfig = {}) {
  const driver = mailConfig.driver || 'none';
  const outbox = [];
  let transport = null;

  if (driver === 'smtp') {
    const nodemailer = require('nodemailer');
    const { host, port, secure, user, pass } = mailConfig.smtp || {};
    if (!host || !mailConfig.from) throw new Error('SMTP_HOST and MAIL_FROM are required when MAIL_DRIVER=smtp');
    transport = nodemailer.createTransport({ host, port, secure, auth: user ? { user, pass } : undefined, disableFileAccess: true, disableUrlAccess: true });
  }

  return {
    enabled: driver !== 'none',
    driver,
    outbox,
    async send({ to, subject, text }) {
      if (driver === 'none') return { delivered: false };
      if (driver === 'memory') { outbox.push({ to, subject, text }); return { delivered: true }; }
      try {
        await transport.sendMail({ from: mailConfig.from, to, subject, text });
        return { delivered: true };
      } catch (error) {
        console.error('[mail] delivery failed:', error.message);
        return { delivered: false };
      }
    }
  };
}

const COPY = {
  invite: {
    en: (app, company, link) => ({ subject: `You're invited to ${company || app}`, text: `You have been invited to ${company || app} on ${app}.\n\nSet your password and activate your account (link valid for 7 days):\n${link}\n\nIf you were not expecting this, ignore this email.` }),
    ar: (app, company, link) => ({ subject: `دعوة للانضمام إلى ${company || app}`, text: `تمت دعوتك للانضمام إلى ${company || app} على ${app}.\n\nعيّن كلمة المرور وفعّل حسابك (الرابط صالح لمدة 7 أيام):\n${link}\n\nإذا لم تكن تتوقع هذه الرسالة فتجاهلها.` })
  },
  password_reset: {
    en: (app, _c, link) => ({ subject: `Reset your ${app} password`, text: `Use this link to set a new password (valid for 1 hour):\n${link}\n\nIf you did not request this, you can ignore this email.` }),
    ar: (app, _c, link) => ({ subject: `إعادة تعيين كلمة مرور ${app}`, text: `استخدم هذا الرابط لتعيين كلمة مرور جديدة (صالح لمدة ساعة):\n${link}\n\nإذا لم تطلب ذلك فتجاهل هذه الرسالة.` })
  },
  subscription_expiring: {
    en: (app, company, days) => ({ subject: `${company}: subscription ends in ${days} day(s)`, text: `The ${app} subscription for ${company} ends in ${days} day(s). Contact us to renew. Your data is kept safe.` }),
    ar: (app, company, days) => ({ subject: `${company}: ينتهي الاشتراك خلال ${days} يوم`, text: `ينتهي اشتراك ${company} في ${app} خلال ${days} يوم. تواصل معنا للتجديد. بياناتك محفوظة.` })
  },
  subscription_expired: {
    en: (app, company) => ({ subject: `${company}: subscription expired`, text: `The ${app} subscription for ${company} has expired. Your data is preserved; renew to restore full access.` }),
    ar: (app, company) => ({ subject: `${company}: انتهى الاشتراك`, text: `انتهى اشتراك ${company} في ${app}. بياناتك محفوظة؛ جدّد الاشتراك لاستعادة الوصول الكامل.` })
  }
};

function compose(kind, locale, ...args) {
  const set = COPY[kind];
  return (set[locale] || set.en)(...args);
}

module.exports = { createMailer, compose };
