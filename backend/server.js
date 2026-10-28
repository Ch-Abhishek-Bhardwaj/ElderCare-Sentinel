// Alert server: sends a real email (SMTP) and, optionally, a phone call + SMS (Twilio).
// Setup:  npm i express cors nodemailer twilio dotenv     (package.json needs "type": "module")
// Run:    node server.js
//
// .env
//   PORT=5000
//   SMTP_HOST=smtp.gmail.com
//   SMTP_PORT=465
//   SMTP_USER=you@gmail.com
//   SMTP_PASS=your-gmail-app-password
//   ALERT_EMAIL=caregiver@example.com
//   # optional, only for phone call + SMS
//   TWILIO_SID=ACxxxxxxxx
//   TWILIO_TOKEN=xxxxxxxx
//   TWILIO_FROM=+1xxxxxxxxxx        (your Twilio number, the caller)
//   ALERT_PHONE=+919876543210       (caregiver number, used if the form has none)

import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import nodemailer from 'nodemailer';
import twilio from 'twilio';

const app = express();
app.use(cors({ origin: ['http://localhost:3000', 'http://localhost:5173'] }));
app.use(express.json());

const smtpPort = Number(process.env.SMTP_PORT || 465);

const mailer =
  process.env.SMTP_USER && process.env.SMTP_PASS
    ? nodemailer.createTransport({
        host: process.env.SMTP_HOST || 'smtp.gmail.com',
        port: smtpPort,
        secure: smtpPort === 465,
        auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
      })
    : null;

// Only create the Twilio client when real credentials are present
const phone =
  process.env.TWILIO_SID && process.env.TWILIO_TOKEN
    ? twilio(process.env.TWILIO_SID, process.env.TWILIO_TOKEN)
    : null;

const escapeXml = t => t.replace(/[<>&'"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c]);

const result = (channel, promise) =>
  promise.then(
    () => ({ channel, ok: true }),
    e => ({ channel, ok: false, error: e.message })
  );

app.post('/api/alert', async (req, res) => {
  const { reason, time, caregiver = {} } = req.body || {};
  if (!reason) return res.status(400).json({ error: 'reason is required' });

  const text = `EMERGENCY ALERT: ${reason} at ${time || new Date().toLocaleString()}. Please check on them immediately.`;
  const jobs = [];

  // email: caregiver form address + ALERT_EMAIL from .env (duplicates removed)
  const recipients = [...new Set([caregiver.email, process.env.ALERT_EMAIL].filter(Boolean))];
  if (recipients.length) {
    jobs.push(
      result(
        'Email',
        (async () => {
          if (!mailer) throw new Error('SMTP not configured');
          await mailer.sendMail({
            from: `"ElderCare Alert" <${process.env.SMTP_USER}>`,
            to: recipients.join(','),
            subject: `EMERGENCY: ${reason}`,
            text
          });
        })()
      )
    );
  }

  // Phone call + SMS (needs Twilio)
  const callTo = caregiver.phone || process.env.ALERT_PHONE;
  if (callTo) {
    jobs.push(
      result(
        'Phone call',
        (async () => {
          if (!phone) throw new Error('Twilio not configured');
          await phone.calls.create({
            to: callTo,
            from: process.env.TWILIO_FROM,
            twiml: `<Response><Say loop="3">${escapeXml(text)}</Say></Response>`
          });
        })()
      ),
      result(
        'SMS',
        (async () => {
          if (!phone) throw new Error('Twilio not configured');
          await phone.messages.create({ to: callTo, from: process.env.TWILIO_FROM, body: text });
        })()
      )
    );
  }

  res.json({ results: await Promise.all(jobs) });
});

// Open http://localhost:5000/api/test-email in a browser to check your email setup
app.get('/api/test-email', async (req, res) => {
  try {
    if (!mailer) throw new Error('SMTP not configured (check SMTP_USER and SMTP_PASS in .env)');
    await mailer.sendMail({
      from: `"ElderCare Alert" <${process.env.SMTP_USER}>`,
      to: process.env.ALERT_EMAIL || process.env.SMTP_USER,
      subject: 'ElderCare test email',
      text: 'If you can read this, email alerts work.'
    });
    res.send('Email sent. Check the inbox (and spam folder).');
  } catch (e) {
    res.status(500).send(`Failed: ${e.message}`);
  }
});

// Open http://localhost:5000/api/test-call to check your call setup
app.get('/api/test-call', async (req, res) => {
  try {
    if (!phone) throw new Error('Twilio not configured (check TWILIO_SID and TWILIO_TOKEN in .env)');
    if (!process.env.ALERT_PHONE) throw new Error('Add ALERT_PHONE to .env first');
    await phone.calls.create({
      to: process.env.ALERT_PHONE,
      from: process.env.TWILIO_FROM,
      twiml: '<Response><Say>This is a test call from your ElderCare system.</Say></Response>'
    });
    res.send('Call started. The phone should ring in a few seconds.');
  } catch (e) {
    res.status(500).send(`Failed: ${e.message}`);
  }
});

app.listen(process.env.PORT || 5000, () => console.log(`Alert server running on port ${process.env.PORT || 5000}`));