import { Resend } from 'resend';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.join(__dirname, '../apps/api/.env') });

async function testResend() {
  const apiKey = process.env.RESEND_API_KEY;
  const fromEmail = process.env.RESEND_FROM_EMAIL;

  if (!apiKey || !fromEmail) {
    console.error('❌ Missing RESEND_API_KEY or RESEND_FROM_EMAIL in .env');
    process.exit(1);
  }

  const resend = new Resend(apiKey);
  console.log(`Sending test email from: ${fromEmail}`);

  try {
    const { data, error } = await resend.emails.send({
      from: fromEmail,
      to: 'delivered@resend.dev', // Resend's testing email
      subject: 'AtomicQueue - Resend Test Integration',
      html: '<p><strong>Success!</strong> Resend is correctly configured in your AtomicQueue backend.</p>'
    });

    if (error) {
      console.error('❌ Resend API Error:', error);
      process.exit(1);
    }

    console.log('✅ Success! Resend API accepted the email request.');
    console.log('Response ID:', data?.id);
  } catch (err) {
    console.error('❌ Unexpected error:', err);
    process.exit(1);
  }
}

testResend();
