require('dotenv').config();
const nodemailer = require('nodemailer');
const axios = require('axios');
const path = require('path');
const fs = require('fs');
const FormData = require('form-data');

const APK_FULL_PATH = '/home/kharra/Documents/projects/ascend_internal_app/android/app/build/outputs/apk/staging/app-staging.apk';

function log(msg) {
  console.log(`[${new Date().toLocaleTimeString('en-IN')}] ${msg}`);
}

async function getEuServer() {
  try {
    const res = await axios.get('https://api.gofile.io/servers', { timeout: 15000 });
    const servers = res.data.data.servers || [];
    const eu = servers.find(s => s.name.includes('eu'));
    return (eu || servers[0]).name;
  } catch {
    return 'store1';
  }
}

async function uploadToGoFile(apkPath, attempt = 1) {
  const server = await getEuServer();
  log(`Server: ${server} (attempt ${attempt})`);

  try {
    const form = new FormData();
    form.append('file', fs.createReadStream(apkPath));

    log('Uploading APK to GoFile...');
    const uploadRes = await axios.post(`https://${server}.gofile.io/uploadFile`, form, {
      headers: form.getHeaders(),
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
      timeout: 0,
      onUploadProgress: (e) => {
        if (e.total) process.stdout.write(`\rUploading... ${Math.round((e.loaded / e.total) * 100)}%`);
      },
    });

    console.log('');
    const link = uploadRes.data.data.downloadPage;
    if (!link) throw new Error('No download link in response');
    log(`Upload done. Link: ${link}`);
    return link;
  } catch (err) {
    console.log('');
    if (attempt < 3) {
      log(`Upload failed (${err.message}), retrying in 5s...`);
      await new Promise(r => setTimeout(r, 5000));
      return uploadToGoFile(apkPath, attempt + 1);
    }
    throw err;
  }
}

async function sendEmail(downloadLink) {
  const recipients = process.env.APK_EMAIL_RECIPIENTS || process.env.EMAIL_RECIPIENTS;
  const sender = process.env.EMAIL_SENDER;
  const password = process.env.GMAIL_APP_PASSWORD;

  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: sender, pass: password },
  });

  await transporter.verify();

  const now = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
  const fileName = `app-staging-${new Date().toISOString().slice(0, 10)}.apk`;

  await transporter.sendMail({
    from: sender,
    to: recipients,
    subject: `[STAGING APK] Ready — ${new Date().toLocaleDateString('en-IN')}`,
    priority: 'high',
    headers: { 'X-Priority': '1', 'X-MSMail-Priority': 'High', 'Importance': 'High' },
    html: `
      <p>Hi,</p>
      <p>Staging build is ready.</p>
      <table style="border-collapse:collapse;margin:12px 0">
        <tr><td style="padding:4px 12px 4px 0;color:#555">File</td><td><b>${fileName}</b></td></tr>
        <tr><td style="padding:4px 12px 4px 0;color:#555">Built at</td><td>${now}</td></tr>
      </table>
      <p>
        <a href="${downloadLink}" style="background:#1a73e8;color:#fff;padding:10px 20px;border-radius:4px;text-decoration:none;display:inline-block">
          Download Staging APK
        </a>
      </p>
      <p style="color:#888;font-size:12px">Sent by Build Bot</p>
    `,
    text: `Staging build ready.\n\nFile: ${fileName}\nBuilt at: ${now}\n\nDownload: ${downloadLink}`,
  });

  log(`Email sent to ${recipients}`);
}

async function main() {
  try {
    if (!fs.existsSync(APK_FULL_PATH)) throw new Error(`APK not found at: ${APK_FULL_PATH}`);
    const apkSize = (fs.statSync(APK_FULL_PATH).size / (1024 * 1024)).toFixed(2);
    log(`APK found: ${path.basename(APK_FULL_PATH)} (${apkSize} MB)`);

    const link = await uploadToGoFile(APK_FULL_PATH);
    await sendEmail(link);

    log('All done!');
  } catch (err) {
    console.error(`\n[ERROR] ${err.message}`);
  }
}

main();
