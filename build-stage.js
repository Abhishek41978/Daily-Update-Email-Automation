require('dotenv').config();
const { execSync } = require('child_process');
const nodemailer = require('nodemailer');
const axios = require('axios');
const path = require('path');
const fs = require('fs');
const FormData = require('form-data');

const ANDROID_DIR = process.env.ANDROID_PROJECT_PATH || '/home/kharra/Documents/projects/ascend_internal_app/android';
const APK_RELATIVE_PATH = 'app/build/outputs/apk/staging/app-staging.apk';
const APK_FULL_PATH = path.join(ANDROID_DIR, APK_RELATIVE_PATH);

const STAGING_URL = 'https://staging.ascendcap.in';
const ENV_FILES = ['src/env.json', 'src/helpers/env.json'];

function log(msg) {
  console.log(`[${new Date().toLocaleTimeString('en-IN')}] ${msg}`);
}

function setStagingUrl(projectDir) {
  const content = JSON.stringify({ site_api: STAGING_URL }, null, 2);
  for (const file of ENV_FILES) {
    const filePath = path.join(projectDir, file);
    if (fs.existsSync(filePath)) fs.writeFileSync(filePath, content);
  }
  log('Staging URL set.');
}

function runBuild(branch = 'develop') {
  const projectDir = path.dirname(ANDROID_DIR);
  const worktreePath = `/tmp/apk-build-${Date.now()}`;

  log(`Fetching origin/${branch}...`);
  execSync(`git fetch origin ${branch}`, { cwd: projectDir, stdio: 'inherit' });

  log('Creating isolated build worktree...');
  execSync(`git worktree add ${worktreePath} origin/${branch}`, { cwd: projectDir, stdio: 'inherit' });

  try {
    // gitignored files the build needs — copy from main project
    execSync(`cp ${projectDir}/android/gradle/wrapper/gradle-wrapper.jar ${worktreePath}/android/gradle/wrapper/gradle-wrapper.jar`);
    execSync(`cp ${projectDir}/android/local.properties ${worktreePath}/android/local.properties`);
    // symlink node_modules so native Gradle plugins (VisionCamera, Skia, etc.) find their packages
    execSync(`ln -s ${projectDir}/node_modules ${worktreePath}/node_modules`);
    // patch metro.config.js: Metro resolves symlinks to real paths and only watches its projectRoot
    // adding watchFolders + nodeModulesPaths makes the JS bundler find @babel/runtime and friends
    const metroConfigPath = `${worktreePath}/metro.config.js`;
    const metroConfig = fs.readFileSync(metroConfigPath, 'utf8');
    fs.writeFileSync(metroConfigPath, metroConfig.replace(
      'mergeConfig(getDefaultConfig(__dirname), {})',
      `mergeConfig(getDefaultConfig(__dirname), {
  watchFolders: [${JSON.stringify(projectDir)}],
  resolver: { nodeModulesPaths: [${JSON.stringify(projectDir + '/node_modules')}] },
})`
    ));

    setStagingUrl(worktreePath);

    log('Starting Gradle staging build...');
    execSync('./gradlew assembleStaging', {
      cwd: `${worktreePath}/android`,
      stdio: 'inherit',
      timeout: 15 * 60 * 1000,
    });
    log('Build completed.');

    // copy APK to original location so test-stage.js still works
    execSync(`cp ${worktreePath}/android/app/build/outputs/apk/staging/app-staging.apk ${ANDROID_DIR}/app/build/outputs/apk/staging/app-staging.apk`);
  } finally {
    log('Cleaning up worktree...');
    execSync(`git worktree remove --force ${worktreePath}`, { cwd: projectDir, stdio: 'inherit' });
    log('Your working directory was not touched.');
  }
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
      timeout: 0, // no timeout — wait as long as needed
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

async function getPrTitle(branch) {
  try {
    const workspace = process.env.BITBUCKET_WORKSPACE;
    const repos = (process.env.BITBUCKET_REPOSITORIES || '').split(',').map(r => r.trim());
    const auth = { username: process.env.BITBUCKET_EMAIL, password: process.env.BITBUCKET_API_TOKEN };

    for (const repo of repos) {
      const res = await axios.get(
        `https://api.bitbucket.org/2.0/repositories/${workspace}/${repo}/pullrequests?state=OPEN&state=MERGED&q=source.branch.name="${branch}"&pagelen=5`,
        { auth, timeout: 10000 }
      );
      const pr = res.data.values?.[0];
      if (pr) return pr.title;
    }
  } catch {
    // silently skip if API fails
  }
  return null;
}

async function sendEmail(downloadLink, branch = 'develop') {
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
  const prTitle = await getPrTitle(branch);

  await transporter.sendMail({
    from: sender,
    to: recipients,
    subject: `[STAGING APK] ${branch} — ${new Date().toLocaleDateString('en-IN')}`,
    priority: 'high',
    headers: { 'X-Priority': '1', 'X-MSMail-Priority': 'High', 'Importance': 'High' },
    html: `
      <p>Hi,</p>
      <p>Staging build is ready.</p>
      <table style="border-collapse:collapse;margin:12px 0">
        <tr><td style="padding:4px 12px 4px 0;color:#555">Branch</td><td><b style="font-family:monospace;font-size:13px">${branch}</b></td></tr>
        ${prTitle ? `<tr><td style="padding:4px 12px 4px 0;color:#555">PR Title</td><td>${prTitle}</td></tr>` : ''}
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
    const args = process.argv.slice(2);
    const branchFlag = args.indexOf('--branch');
    const branch = branchFlag !== -1 ? args[branchFlag + 1] : 'develop';
    log(`Branch: ${branch}`);
    runBuild(branch);

    if (!fs.existsSync(APK_FULL_PATH)) throw new Error(`APK not found at: ${APK_FULL_PATH}`);
    const apkSize = (fs.statSync(APK_FULL_PATH).size / (1024 * 1024)).toFixed(2);
    log(`APK found: ${path.basename(APK_FULL_PATH)} (${apkSize} MB)`);

    const link = await uploadToGoFile(APK_FULL_PATH);
    await sendEmail(link, branch);

    log('Done. APK uploaded and email sent.');
    process.exit(0);
  } catch (err) {
    console.error(`\n[ERROR] ${err.message}`);
    process.exit(1);
  }
}

main();
