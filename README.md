# Daily Update Email Automation

A lightweight Node.js automation suite that handles two things — keeping your team updated on daily Bitbucket activity, and delivering Android staging builds to testers without any manual intervention.

---

## Overview

**Daily Report** — Pulls your Bitbucket PR activity at a scheduled time each evening, formats it into a clean digest, and delivers it via Gmail and Telegram.

**Staging APK Builder** — One command fetches the latest code from any branch, builds a staging Android APK in a completely isolated environment, uploads it to GoFile, and emails the download link to your testers. Your local working directory is never touched.

---

## Getting Started

```bash
npm install
cp .env.example .env
# Fill in your credentials in .env
```

---

## Commands

| Command | Description |
|---|---|
| `npm start` | Generate report and preview in console (no email sent) |
| `npm run send` | Generate and deliver report via Gmail + Telegram |
| `npm run stage` | Build staging APK and email download link to testers |
| `npm run pm2` | Start with PM2 as a background cron process |
| `npm test` | Run test script |

---

## Staging APK — How It Works

```bash
npm run stage                           # Build from develop branch
npm run stage -- --branch feat/xyz     # Build from a specific branch
```

1. Fetches the target branch from remote
2. Creates an isolated Git worktree in `/tmp` — your working directory is never modified
3. Copies gitignored build dependencies (`local.properties`, `gradle-wrapper.jar`) into the worktree
4. Sets the staging server URL in `env.json`
5. Runs `./gradlew assembleStaging` (~5–10 minutes)
6. Uploads the APK to GoFile.io
7. Sends a high-priority email with the branch name, PR title, and download link

---

## Environment Variables

```bash
# Bitbucket — for PR report and PR title lookup in staging emails
BITBUCKET_WORKSPACE=your_workspace
BITBUCKET_REPOSITORIES=repo1,repo2
BITBUCKET_EMAIL=your@atlassian-email.com
BITBUCKET_API_TOKEN=your_api_token

# Gmail — for sending reports and APK delivery emails
EMAIL_SENDER=you@gmail.com
GMAIL_APP_PASSWORD=xxxx_xxxx_xxxx_xxxx    # Gmail App Password (requires 2FA)
EMAIL_RECIPIENTS=team@example.com

# Telegram — for daily report delivery
TELEGRAM_BOT_TOKEN=your_bot_token
TELEGRAM_CHAT_ID=your_chat_id

# Schedule
TIMEZONE=Asia/Kolkata
REPORT_CRON=15 21 * * *                   # Runs daily at 9:15 PM
REPORT_AUTHOR_MATCH=Abhishek

# Staging APK
APK_EMAIL_RECIPIENTS=tester1@example.com,tester2@example.com
# ANDROID_PROJECT_PATH=/custom/path/to/android    # Optional override
```

---

## Project Structure

| File | Purpose |
|---|---|
| `index.js` | Daily Bitbucket report script |
| `build-stage.js` | Full staging pipeline — build, upload, and email |
| `test-stage.js` | Skip build — upload and email an existing APK |
| `ecosystem.config.js` | PM2 configuration for cron scheduling |
| `.env.example` | Environment variable reference |
