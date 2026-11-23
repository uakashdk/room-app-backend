import 'dotenv/config';
import { z } from 'zod';

const schema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(8790),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  FIREBASE_SERVICE_ACCOUNT_JSON: z.string().optional(),
  GOOGLE_APPLICATION_CREDENTIALS: z.string().optional(),
  CORS_ORIGINS: z.string().default(''),
  // Email OTP login (any SMTP provider: Gmail app password, Brevo, SendGrid SMTP, Zoho, Amazon SES...)
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().default(587),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  MAIL_FROM: z.string().default('DesiVox <no-reply@desivox.co.in>'),
  // PayPal recharge. Keys come ONLY from this server's .env (never in the app, never in git).
  PAYPAL_CLIENT_ID: z.string().optional(),
  PAYPAL_CLIENT_SECRET: z.string().optional(),
  PAYPAL_MODE: z.enum(['sandbox', 'live']).default('sandbox'),
  PAYPAL_WEBHOOK_ID: z.string().optional(),
  PUBLIC_API_URL: z.string().url().default('https://api.desivox.co.in'), // where PayPal sends the browser back to
  APP_SCHEME: z.string().regex(/^[a-z][a-z0-9+.-]*$/).default('desivox'), // the app's link scheme (app.json "scheme")
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error('Wrong or missing environment values:', parsed.error.flatten().fieldErrors);
  process.exit(1); // the server must not start with a broken setup
}
if (!parsed.data.FIREBASE_SERVICE_ACCOUNT_JSON && !parsed.data.GOOGLE_APPLICATION_CREDENTIALS) {
  console.error('Set GOOGLE_APPLICATION_CREDENTIALS (path of the service account key) or FIREBASE_SERVICE_ACCOUNT_JSON.');
  process.exit(1);
}

export const env = {
  ...parsed.data,
  isProd: parsed.data.NODE_ENV === 'production',
  corsOrigins: parsed.data.CORS_ORIGINS.split(',').map((x) => x.trim()).filter(Boolean),
};
