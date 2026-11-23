import { createHash, randomInt, timingSafeEqual } from 'crypto';
import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import nodemailer from 'nodemailer';
import { adminAuth, db } from '../config/firebase';
import { env } from '../config/env';
import { AppError } from '../middleware/error-handler';

const OTP_TTL_MS = 10 * 60_000; // the code works for 10 minutes
const RESEND_AFTER_MS = 45_000; // one new code per 45 seconds for the same email
const MAX_ATTEMPTS = 5; // wrong tries before the code is burned
const DAILY_LIMIT = 10; // codes per email per day (stops someone spamming a stranger's inbox)

const normalize = (email: string) => email.trim().toLowerCase();
const docFor = (email: string) => db.doc(`emailOtps/${createHash('sha256').update(email).digest('hex')}`);
const hashCode = (email: string, code: string) => createHash('sha256').update(`${email}:${code}`).digest();

// ReturnType<...> works even where the `nodemailer` namespace type is not visible
type Mailer = ReturnType<typeof nodemailer.createTransport>;

let transporter: Mailer | null = null;
function mailer(): Mailer | null {
  if (!env.SMTP_HOST) return null;
  transporter ??= nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    secure: env.SMTP_PORT === 465,
    auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASS } : undefined,
  });
  return transporter;
}

function emailHtml(code: string) {
  return `<div style="font-family:Arial,sans-serif;max-width:420px;margin:auto;padding:28px;background:#160D20;color:#fff;border-radius:18px">
  <h2 style="margin:0 0 6px;color:#F4C542">DesiVox</h2>
  <p style="color:#B8ADCA;margin:0 0 22px">Use this code to log in:</p>
  <div style="font-size:34px;font-weight:800;letter-spacing:10px;text-align:center;padding:16px;background:#21102F;border-radius:14px;color:#F4C542">${code}</div>
  <p style="color:#82758F;font-size:12px;margin-top:22px">This code expires in 10 minutes. If you did not ask for it, you can ignore this email.</p></div>`;
}

/** Creates a 6-digit code, stores only its hash, and emails it. */
export async function sendEmailOtp(rawEmail: string): Promise<{ resendAfter: number }> {
  const email = normalize(rawEmail);
  const ref = docFor(email);
  const now = Date.now();
  const code = String(randomInt(100000, 1000000));

  // check the limits and save the new code in one transaction, so two quick taps cannot bypass them
  await db.runTransaction(async (t) => {
    const snap = await t.get(ref);
    const d = snap.data();
    if (d?.sentAt && now - d.sentAt.toMillis() < RESEND_AFTER_MS) {
      throw new AppError(429, 'too-soon', 'Please wait a little before asking for a new code.');
    }
    const sameDay = d?.dayStart && now - d.dayStart.toMillis() < 86_400_000;
    const sentToday = sameDay ? Number(d?.sentToday ?? 0) : 0;
    if (sentToday >= DAILY_LIMIT) throw new AppError(429, 'daily-limit', 'Too many codes requested today. Try again tomorrow.');
    t.set(ref, {
      email,
      codeHash: hashCode(email, code).toString('hex'),
      expiresAt: Timestamp.fromMillis(now + OTP_TTL_MS),
      attempts: 0,
      sentAt: Timestamp.fromMillis(now),
      dayStart: sameDay ? d!.dayStart : Timestamp.fromMillis(now),
      sentToday: sentToday + 1,
    });
  });

  const m = mailer();
  if (!m) {
    if (env.isProd) throw new AppError(500, 'mail-not-configured', 'Email sending is not set up on the server.');
    console.log(`[DEV] Email OTP for ${email}: ${code}  (set SMTP_* in .env to send real emails)`);
  } else {
    try {
      await m.sendMail({
        from: env.MAIL_FROM,
        to: email,
        subject: `${code} is your DesiVox login code`,
        text: `Your DesiVox login code is ${code}. It expires in 10 minutes.`,
        html: emailHtml(code),
      });
    } catch (e) {
      console.error('Could not send OTP email:', e);
      await ref.delete().catch(() => {}); // do not keep a code the person never received
      throw new AppError(502, 'mail-failed', 'We could not send the email. Please check the address and try again.');
    }
  }
  return { resendAfter: RESEND_AFTER_MS / 1000 };
}

/** Checks the code. On success returns a Firebase custom token for the account of this email (created if new). */
export async function verifyEmailOtp(rawEmail: string, code: string): Promise<string> {
  const email = normalize(rawEmail);
  const ref = docFor(email);

  // The transaction RETURNS the outcome instead of throwing, so the wrong-attempt counter is really saved.
  const outcome = await db.runTransaction(async (t) => {
    const snap = await t.get(ref);
    const d = snap.data();
    if (!snap.exists || !d) return 'missing' as const;
    if (d.expiresAt.toMillis() < Date.now()) {
      t.delete(ref);
      return 'expired' as const;
    }
    if (Number(d.attempts) >= MAX_ATTEMPTS) return 'locked' as const;

    const given = hashCode(email, code);
    const stored = Buffer.from(String(d.codeHash), 'hex');
    const ok = stored.length === given.length && timingSafeEqual(stored, given);
    if (!ok) {
      t.update(ref, { attempts: FieldValue.increment(1) });
      return 'wrong' as const;
    }
    t.delete(ref); // a code works only once
    return 'ok' as const;
  });
  if (outcome === 'missing') throw new AppError(400, 'otp-invalid', 'Invalid or expired code. Please request a new one.');
  if (outcome === 'expired') throw new AppError(400, 'otp-expired', 'This code has expired. Please request a new one.');
  if (outcome === 'locked') throw new AppError(429, 'otp-locked', 'Too many wrong attempts. Please request a new code.');
  if (outcome === 'wrong') throw new AppError(400, 'otp-wrong', 'Incorrect code. Please try again.');

  let user;
  try {
    user = await adminAuth.getUserByEmail(email);
  } catch (e: any) {
    if (e?.code !== 'auth/user-not-found') throw e;
    user = await adminAuth.createUser({ email, emailVerified: true });
  }
  if (user.disabled) throw new AppError(403, 'account-blocked', 'This account cannot log in.');
  if (!user.emailVerified) await adminAuth.updateUser(user.uid, { emailVerified: true });
  return adminAuth.createCustomToken(user.uid);
}