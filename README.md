# daily-task-report

Node.js automation project — two main jobs:
1. **Daily Bitbucket report** — pulls your PR activity and sends it via Gmail + Telegram every evening
2. **Staging APK builder** — one command se latest code pull karo, APK banao, aur email pe bhejo

---

## Setup

```bash
npm install
cp .env.example .env
# .env mein apni values bharo (neeche dekho)
```

---

## Commands

| Command | Kya karta hai |
|---|---|
| `npm start` | Report generate karta hai (send nahi karta, sirf console pe dikhata hai) |
| `npm run send` | Report generate karke Gmail + Telegram pe bhejta hai |
| `npm run stage` | Staging APK build karke GoFile pe upload karta hai, phir email bhejta hai |
| `npm run pm2` | PM2 se background mein cron schedule ke saath start karta hai |
| `npm test` | Test script chalta hai |

---

## npm run stage — kaise kaam karta hai

```bash
npm run stage                          # develop branch se build
npm run stage -- --branch feat/xyz    # kisi bhi branch se build
```

**Flow:**
1. `git fetch` + isolated worktree banata hai (tera project untouched rehta hai)
2. Staging URL (`https://staging.ascendcap.in`) set karta hai env.json mein
3. Gradle se `assembleStaging` build karta hai (~5-10 min)
4. APK ko GoFile.io pe upload karta hai
5. Download link ke saath email bhejta hai `APK_EMAIL_RECIPIENTS` ko

> Tera `ascend_internal_app` working directory kabhi touch nahi hota — build ek temp folder mein hoti hai.

---

## .env Variables

```bash
# Bitbucket — PR report + staging APK mein PR title dikhane ke liye
BITBUCKET_WORKSPACE=your_workspace
BITBUCKET_REPOSITORIES=repo1,repo2
BITBUCKET_EMAIL=your@email.com
BITBUCKET_API_TOKEN=your_token

# Gmail — report aur APK mail bhejne ke liye
EMAIL_SENDER=you@gmail.com
GMAIL_APP_PASSWORD=xxxx_xxxx_xxxx_xxxx   # Gmail App Password (2FA wala)
EMAIL_RECIPIENTS=you@example.com          # daily report recipients

# Telegram — daily report ke liye
TELEGRAM_BOT_TOKEN=your_bot_token
TELEGRAM_CHAT_ID=your_chat_id

# Cron schedule
TIMEZONE=Asia/Kolkata
REPORT_CRON=15 21 * * *    # roz raat 9:15 baje
REPORT_AUTHOR_MATCH=Abhishek

# Staging APK
APK_EMAIL_RECIPIENTS=email1@example.com,email2@example.com
# ANDROID_PROJECT_PATH=/custom/path/to/android   # optional, default already set hai
```

---

## Files

| File | Kaam |
|---|---|
| `index.js` | Daily report script |
| `build-stage.js` | Staging APK build + upload + email |
| `test-stage.js` | Build skip karke existing APK seedha upload + email karo |
| `ecosystem.config.js` | PM2 config for cron |
| `.env.example` | Saare env variables ka template |
