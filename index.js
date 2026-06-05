require('dotenv').config();
const axios = require('axios');
const nodemailer = require('nodemailer');
const TelegramBot = require('node-telegram-bot-api');
const cron = require('node-cron');
const fs = require('fs');
const path = require('path');

const DEFAULT_REPOSITORIES = ['ascend_los', 'ascend_internal_app'];
const LOG_FILE = path.join(__dirname, 'logs.txt');
const SENT_LOG_FILE = path.join(__dirname, '.sent-log.json');
const BITBUCKET_API_BASE_URL = 'https://api.bitbucket.org/2.0';
const DEFAULT_SCHEDULE = '15 21 * * *';

const CONFIG = {
  timezone: process.env.TIMEZONE || 'Asia/Kolkata',
  cronSchedule: process.env.REPORT_CRON || DEFAULT_SCHEDULE,
  reportAuthorMatch: process.env.REPORT_AUTHOR_MATCH || 'Abhishek',
  bitbucket: {
    workspace: process.env.BITBUCKET_WORKSPACE || 'ascendcap',
    repositories: parseRepositories(process.env.BITBUCKET_REPOSITORIES),
    email: process.env.BITBUCKET_EMAIL,
    apiToken: process.env.BITBUCKET_API_TOKEN,
  },
  email: {
    sender: process.env.EMAIL_SENDER,
    recipients: parseList(process.env.EMAIL_RECIPIENTS),
    gmailAppPassword: process.env.GMAIL_APP_PASSWORD,
  },
  telegram: {
    token: process.env.TELEGRAM_BOT_TOKEN,
    chatId: process.env.TELEGRAM_CHAT_ID,
  },
};

const bitbucketClient = axios.create({
  baseURL: BITBUCKET_API_BASE_URL,
  timeout: 30000,
  auth: {
    username: CONFIG.bitbucket.email || '',
    password: CONFIG.bitbucket.apiToken || '',
  },
  headers: {
    Accept: 'application/json',
    'User-Agent': 'daily-task-report/1.0',
  },
});

let cachedWorkspaceRepositories = null;

function parseList(value) {
  return (value || '')
    .split(',')
    .map(item => item.trim())
    .filter(Boolean);
}

function parseRepositories(value) {
  const repositories = parseList(value);
  return repositories.length > 0 ? repositories : DEFAULT_REPOSITORIES;
}

function formatNow() {
  return new Date().toLocaleString('en-IN', {
    timeZone: CONFIG.timezone,
  });
}

function log(message, meta) {
  const line = `[${formatNow()}] ${message}`;
  console.log(line);
  fs.appendFileSync(LOG_FILE, `${line}\n`);

  if (meta !== undefined) {
    const details = typeof meta === 'string' ? meta : JSON.stringify(meta, null, 2);
    console.log(details);
    fs.appendFileSync(LOG_FILE, `${details}\n`);
  }
}

function getReportDate() {
  return new Date().toLocaleDateString('en-CA', {
    timeZone: CONFIG.timezone,
  });
}

function getTimeZoneParts(date, timeZone) {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });

  const parts = formatter.formatToParts(date);
  const map = {};

  for (const part of parts) {
    if (part.type !== 'literal') {
      map[part.type] = part.value;
    }
  }

  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    hour: Number(map.hour),
    minute: Number(map.minute),
    second: Number(map.second),
  };
}

function zonedDateTimeToUtc(dateString, timeZone) {
  const [year, month, day] = dateString.split('-').map(Number);
  const utcGuess = new Date(Date.UTC(year, month - 1, day, 0, 0, 0));
  const zonedParts = getTimeZoneParts(utcGuess, timeZone);
  const zonedAsUtc = Date.UTC(
    zonedParts.year,
    zonedParts.month - 1,
    zonedParts.day,
    zonedParts.hour,
    zonedParts.minute,
    zonedParts.second
  );
  const offset = zonedAsUtc - utcGuess.getTime();
  return new Date(Date.UTC(year, month - 1, day, 0, 0, 0) - offset);
}

function getDateRangeForTimezone(dateString = getReportDate()) {
  const startUtc = zonedDateTimeToUtc(dateString, CONFIG.timezone);
  const nextDay = new Date(`${dateString}T00:00:00Z`);
  nextDay.setUTCDate(nextDay.getUTCDate() + 1);
  const nextDateString = nextDay.toISOString().slice(0, 10);
  const endUtc = zonedDateTimeToUtc(nextDateString, CONFIG.timezone);

  return {
    dateString,
    startIso: startUtc.toISOString(),
    endIso: endUtc.toISOString(),
  };
}

function loadSentLog() {
  try {
    if (fs.existsSync(SENT_LOG_FILE)) {
      return JSON.parse(fs.readFileSync(SENT_LOG_FILE, 'utf8'));
    }
  } catch (error) {
    log('Failed to read sent log, continuing with empty state.', error.message);
  }

  return {};
}

function getSentLogEntry(dateString) {
  return loadSentLog()[dateString] || null;
}

function markSent(dateString, channel) {
  const sentLog = loadSentLog();
  sentLog[dateString] = {
    sentAt: new Date().toISOString(),
    channel,
  };
  fs.writeFileSync(SENT_LOG_FILE, JSON.stringify(sentLog, null, 2));
}

function maskToken(token) {
  if (!token) {
    return '(missing)';
  }

  if (token.length <= 8) {
    return `${token.slice(0, 2)}***`;
  }

  return `${token.slice(0, 4)}***${token.slice(-4)}`;
}

function summarizeResponseData(data) {
  if (!data) {
    return null;
  }

  if (typeof data === 'string') {
    return data.slice(0, 400);
  }

  try {
    return JSON.stringify(data).slice(0, 400);
  } catch (_) {
    return '[unserializable response data]';
  }
}

function normalizeSlug(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[-_\s]/g, '');
}

function buildRepositoryCandidates(repository) {
  const candidates = new Set([repository]);
  candidates.add(repository.replace(/_/g, '-'));
  candidates.add(repository.replace(/-/g, '_'));
  candidates.add(repository.replace(/[\s]+/g, '-'));
  candidates.add(repository.replace(/[\s]+/g, '_'));
  return [...candidates].filter(Boolean);
}

function logBitbucketAuthFailure(error, context) {
  const response = error.response;
  log(`Bitbucket API request failed for ${context}.`, {
    context,
    status: response?.status || null,
    statusText: response?.statusText || null,
    requestUrl: response?.config?.url || error.config?.url || null,
    authIdentity: CONFIG.bitbucket.email || '(missing)',
    tokenPreview: maskToken(CONFIG.bitbucket.apiToken),
    responseHeaders: response?.headers || null,
    responseData: summarizeResponseData(response?.data),
    message: error.message,
  });
}

function buildBitbucketAccessError(error, repository) {
  const status = error.response?.status;
  const requiredScopes = error.response?.data?.error?.detail?.required;

  if (status === 403 && Array.isArray(requiredScopes) && requiredScopes.length > 0) {
    return new Error(`Bitbucket token is missing required scopes: ${requiredScopes.join(', ')}`);
  }

  if (status === 404 && repository) {
    const suggestions = Array.isArray(error.suggestedRepositories) && error.suggestedRepositories.length > 0
      ? ` Possible matches in ${CONFIG.bitbucket.workspace}: ${error.suggestedRepositories.join(', ')}.`
      : '';
    return new Error(
      `Repository ${CONFIG.bitbucket.workspace}/${repository} was not found for this token. ` +
      `Check the repository slug and confirm the Atlassian account has access.${suggestions}`
    );
  }

  return error;
}

async function bitbucketGet(url, context, config = {}) {
  try {
    const response = await bitbucketClient.get(url, config);
    log(`Bitbucket API ${context} succeeded.`, {
      status: response.status,
      requestUrl: response.config?.url || url,
      authIdentity: CONFIG.bitbucket.email || '(missing)',
    });
    return response.data;
  } catch (error) {
    logBitbucketAuthFailure(error, context);
    throw error;
  }
}

async function bitbucketGetOptional(url, context, fallbackStatus) {
  try {
    const data = await bitbucketGet(url, context);
    return { data, skipped: false };
  } catch (error) {
    if (error.response?.status === fallbackStatus) {
      log(`Bitbucket API ${context} unavailable; using fallback.`, {
        status: error.response.status,
        requestUrl: error.response?.config?.url || error.config?.url || url,
      });
      return { data: { values: [] }, skipped: true };
    }
    throw error;
  }
}

function validateConfig() {
  const missing = [];

  if (!CONFIG.bitbucket.email) missing.push('BITBUCKET_EMAIL');
  if (!CONFIG.bitbucket.apiToken) missing.push('BITBUCKET_API_TOKEN');
  if (!CONFIG.email.sender) missing.push('EMAIL_SENDER');
  if (!CONFIG.email.recipients.length) missing.push('EMAIL_RECIPIENTS');
  if (!CONFIG.email.gmailAppPassword) missing.push('GMAIL_APP_PASSWORD');

  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }
}

async function listWorkspaceRepositories() {
  if (cachedWorkspaceRepositories) {
    return cachedWorkspaceRepositories;
  }

  const values = [];
  let url = `/repositories/${CONFIG.bitbucket.workspace}?pagelen=100`;

  while (url) {
    const data = await bitbucketGet(url, 'workspace repository discovery');
    values.push(...(data.values || []));
    url = data.next || null;
  }

  cachedWorkspaceRepositories = values;
  return values;
}

function pickSuggestedRepositories(repository, availableRepos) {
  const target = normalizeSlug(repository);
  const matches = availableRepos
    .map(repo => repo.slug || repo.full_name || '')
    .filter(Boolean)
    .filter(slug => normalizeSlug(slug).includes(target) || target.includes(normalizeSlug(slug)));

  return [...new Set(matches)].slice(0, 5);
}

async function resolveRepositorySlug(repository) {
  const candidates = buildRepositoryCandidates(repository);
  let lastError = null;

  for (const candidate of candidates) {
    try {
      const repoInfo = await bitbucketGet(
        `/repositories/${CONFIG.bitbucket.workspace}/${candidate}`,
        `${candidate} repository resolution`
      );
      return { repository: candidate, repoInfo };
    } catch (error) {
      lastError = error;
      if (error.response?.status && error.response.status !== 404) {
        throw error;
      }
    }
  }

  if (lastError?.response?.status === 404) {
    try {
      const availableRepos = await listWorkspaceRepositories();
      lastError.suggestedRepositories = pickSuggestedRepositories(repository, availableRepos);
    } catch (_) {
      // Keep the original 404 when discovery is unavailable.
    }
  }

  throw lastError;
}

async function verifyBitbucketAuth() {
  const repository = CONFIG.bitbucket.repositories[0];

  if (!repository) {
    throw new Error('No Bitbucket repositories configured.');
  }

  try {
    const resolved = await resolveRepositorySlug(repository);
    return resolved.repoInfo.full_name || `${CONFIG.bitbucket.workspace}/${resolved.repository}`;
  } catch (error) {
    throw buildBitbucketAccessError(error, repository);
  }
}

async function fetchRepositoryReport(repository, dateRange) {
  const qIssues = encodeURIComponent(`updated_on >= "${dateRange.startIso}" AND updated_on < "${dateRange.endIso}"`);
  const qPullRequests = encodeURIComponent(`created_on >= "${dateRange.startIso}" AND created_on < "${dateRange.endIso}"`);

  let resolvedRepository;
  let repoInfo;
  let basePath;
  let issuesData;
  let pullRequestsData;
  let issuesDisabled = false;

  try {
    const resolved = await resolveRepositorySlug(repository);
    resolvedRepository = resolved.repository;
    repoInfo = resolved.repoInfo;
    basePath = `/repositories/${CONFIG.bitbucket.workspace}/${resolvedRepository}`;

    const [issuesResult, pullRequestsResult] = await Promise.all([
      bitbucketGetOptional(`${basePath}/issues?q=${qIssues}&sort=-updated_on&pagelen=50`, `${repository} issues`, 410),
      bitbucketGet(`${basePath}/pullrequests?q=${qPullRequests}&sort=-created_on&pagelen=50`, `${repository} pull requests`),
    ]);
    issuesData = issuesResult.data;
    issuesDisabled = issuesResult.skipped;
    pullRequestsData = pullRequestsResult;
  } catch (error) {
    throw buildBitbucketAccessError(error, repository);
  }

  const pullRequests = await Promise.all((pullRequestsData.values || []).map(async pr => {
    let description = pr.description || '';
    let descriptionHtml = pr.rendered?.description?.html || '';

    if (basePath && pr.id && !descriptionHtml) {
      try {
        const details = await bitbucketGet(
          `${basePath}/pullrequests/${pr.id}`,
          `${repository} pull request ${pr.id} details`
        );
        description = details.description || description;
        descriptionHtml = details.rendered?.description?.html || descriptionHtml;
      } catch (error) {
        log(`Failed to load rendered description for ${repository} PR ${pr.id}; using raw description.`, error.message);
      }
    }

    return {
      id: pr.id,
      title: pr.title || 'Untitled pull request',
      state: pr.state || 'OPEN',
      createdOn: pr.created_on,
      updatedOn: pr.updated_on,
      author: pr.author?.display_name || 'Unknown',
      description,
      descriptionHtml,
      link: pr.links?.html?.href || null,
    };
  }));

  return {
    repository: resolvedRepository || repository,
    fullName: repoInfo.full_name || `${CONFIG.bitbucket.workspace}/${repository}`,
    repoUrl: repoInfo.links?.html?.href || null,
    issuesDisabled,
    issues: (issuesData.values || []).map(issue => ({
      id: issue.id,
      title: issue.title || 'Untitled issue',
      state: issue.state || 'unknown',
      updatedOn: issue.updated_on,
      link: issue.links?.html?.href || null,
      assignee: issue.assignee?.display_name || 'Unassigned',
    })),
    pullRequests,
  };
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function matchesReportAuthor(...values) {
  return values.some(value => String(value || '')
    .toLowerCase()
    .includes(CONFIG.reportAuthorMatch.toLowerCase()));
}

function formatReportHeadingDate(dateString) {
  const [year, month, day] = dateString.split('-');
  return `${day}/${month}/${year}`;
}

function formatReportTime(isoString) {
  return new Date(isoString).toLocaleTimeString('en-IN', {
    timeZone: CONFIG.timezone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  });
}

function buildAlreadySentMessage(dateString, sentEntry) {
  const channel = sentEntry.channel ? ` by ${sentEntry.channel}` : '';
  const sentTime = sentEntry.sentAt ? ` at ${formatReportTime(sentEntry.sentAt)}` : '';
  return `Today's updates already sent${channel} on ${formatReportHeadingDate(dateString)}${sentTime}.`;
}

function getRepositoryLabel(repository, fullName) {
  const source = `${repository} ${fullName}`.toLowerCase();
  if (source.includes('los')) return 'LMS';
  if (source.includes('internal_app') || source.includes('internal-app')) return 'App';
  return fullName.split('/').pop() || repository;
}

function getPullRequestStatus(pr) {
  return (pr.state || 'OPEN').toUpperCase();
}

function getPullRequestDescription(pr) {
  const value = String(pr.description || '').trim();
  return value || 'No description';
}

function getPullRequestDescriptionHtml(pr) {
  const value = String(pr.descriptionHtml || '').trim();
  return value || '';
}

function buildDescriptionHtml(row) {
  if (row.descriptionHtml) {
    return `<div style="line-height:1.45;word-break:break-word;">${row.descriptionHtml}</div>`;
  }

  return `<div style="white-space:pre-wrap;line-height:1.45;word-break:break-word;">${escapeHtml(row.description)}</div>`;
}

function flattenReportRows(report) {
  return report.repositories.flatMap(repo =>
    repo.pullRequests.map(pr => ({
      repository: getRepositoryLabel(repo.repository, repo.fullName),
      title: pr.title || 'Untitled pull request',
      description: getPullRequestDescription(pr),
      descriptionHtml: getPullRequestDescriptionHtml(pr),
      state: getPullRequestStatus(pr),
      author: pr.author,
      link: pr.link,
    }))
  );
}

function buildPlainTextReport(report) {
  const rows = flattenReportRows(report);
  const lines = [`Today's Updates | ${formatReportHeadingDate(report.date)}`, ''];

  if (rows.length === 0) {
    lines.push(`No pull request updates found for ${CONFIG.reportAuthorMatch}.`);
    return lines.join('\n');
  }

  rows.forEach((row, index) => {
    lines.push(`${index + 1}. ${row.repository}`);
    lines.push(`   Title: ${row.title}`);
    lines.push(`   Description: ${row.description}`);
    lines.push(`   State: ${row.state}`);
    lines.push('');
  });

  return lines.join('\n');
}

function buildHtmlReport(report) {
  const rows = flattenReportRows(report);
  const tableRows = rows.length === 0
    ? '<tr><td colspan="4" style="padding:12px;border:1px solid #dfe3e8;text-align:center;color:#6b7280;">No pull request updates found for today.</td></tr>'
    : rows.map(row => `
      <tr>
        <td style="padding:10px;border:1px solid #dfe3e8;">${escapeHtml(row.repository)}</td>
        <td style="padding:10px;border:1px solid #dfe3e8;">${row.link ? `<a href="${escapeHtml(row.link)}" style="color:#2563eb;text-decoration:none;">${escapeHtml(row.title)}</a>` : escapeHtml(row.title)}</td>
        <td style="padding:10px;border:1px solid #dfe3e8;">${buildDescriptionHtml(row)}</td>
        <td style="padding:10px;border:1px solid #dfe3e8;text-align:center;"><span style="display:inline-block;padding:4px 10px;border-radius:999px;background:#dcfce7;color:#166534;font-size:12px;font-weight:700;">${escapeHtml(row.state)}</span></td>
      </tr>
    `).join('');

  return `
    <div style="font-family:Arial,sans-serif;max-width:860px;margin:0 auto;padding:24px;background:#ffffff;color:#0f172a;">
      <h1 style="margin:0 0 16px;font-size:22px;color:#111827;">Today's Updates | ${escapeHtml(formatReportHeadingDate(report.date))}</h1>
      <table style="width:100%;border-collapse:collapse;font-size:13px;">
        <thead>
          <tr style="background:#f3f4f6;">
            <th style="padding:10px;border:1px solid #dfe3e8;text-align:left;">Repository</th>
            <th style="padding:10px;border:1px solid #dfe3e8;text-align:left;">Title</th>
            <th style="padding:10px;border:1px solid #dfe3e8;text-align:left;">Description</th>
            <th style="padding:10px;border:1px solid #dfe3e8;text-align:left;">State</th>
          </tr>
        </thead>
        <tbody>${tableRows}</tbody>
      </table>
    </div>
  `;
}

function createTransporter() {
  return nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: CONFIG.email.sender,
      pass: CONFIG.email.gmailAppPassword,
    },
  });
}

async function sendEmailReport(report) {
  const transporter = createTransporter();
  await transporter.verify();

  await transporter.sendMail({
    from: CONFIG.email.sender,
    to: CONFIG.email.recipients.join(', '),
    subject: `Today's Updates | ${formatReportHeadingDate(report.date)}`,
    text: buildPlainTextReport(report),
    html: buildHtmlReport(report),
  });

  log('Daily report email sent successfully.', {
    recipients: CONFIG.email.recipients,
    date: report.date,
  });
}

function createTelegramBot() {
  if (!CONFIG.telegram.token) {
    log('Telegram bot token missing. Telegram bot will not start.');
    return null;
  }

  const bot = new TelegramBot(CONFIG.telegram.token, { polling: true });
  registerTelegramHandlers(bot);
  log('Telegram bot polling started.');
  return bot;
}

function isAuthorizedChat(chatId) {
  if (!CONFIG.telegram.chatId) {
    return true;
  }

  return String(chatId) === String(CONFIG.telegram.chatId);
}

async function sendUnauthorizedChatMessage(bot, chatId) {
  await bot.sendMessage(
    chatId,
    `Unauthorized chat ID: ${chatId}\nSet TELEGRAM_CHAT_ID=${chatId} in .env, then restart the service.`
  );
}

function registerTelegramHandlers(bot) {
  bot.onText(/^\/myid(@\w+)?$/, async message => {
    await bot.sendMessage(message.chat.id, `Your chat ID is: ${message.chat.id}`);
  });

  bot.onText(/^\/help(@\w+)?$/, async message => {
    if (!isAuthorizedChat(message.chat.id)) {
      await sendUnauthorizedChatMessage(bot, message.chat.id);
      return;
    }

    await bot.sendMessage(
      message.chat.id,
      '/sendmail or send mail - Send today\'s updates\n/status - Check today\'s send log\n/myid - Show this chat ID\n/help - Show commands'
    );
  });

  bot.onText(/^\/status(@\w+)?$/, async message => {
    if (!isAuthorizedChat(message.chat.id)) {
      await sendUnauthorizedChatMessage(bot, message.chat.id);
      return;
    }

    const reportDate = getReportDate();
    const sentEntry = getSentLogEntry(reportDate);
    await bot.sendMessage(
      message.chat.id,
      sentEntry
        ? buildAlreadySentMessage(reportDate, sentEntry)
        : `No send log exists for ${reportDate}.`
    );
  });

  bot.onText(/^(?:\/sendmail(?:@\w+)?|send\s*mail|sendmail)$/i, async message => {
    if (!isAuthorizedChat(message.chat.id)) {
      await sendUnauthorizedChatMessage(bot, message.chat.id);
      return;
    }

    await bot.sendMessage(message.chat.id, 'Preparing daily task report...');

    try {
      const result = await sendDailyReport({
        trigger: 'telegram',
        notifyTelegram: false,
      });
      await bot.sendMessage(message.chat.id, result.message);
    } catch (error) {
      log('Telegram-triggered report failed.', error.message);
      await bot.sendMessage(message.chat.id, `Failed to send report: ${error.message}`);
    }
  });
}

async function buildDailyReport() {
  const dateRange = getDateRangeForTimezone();
  const repositories = [];

  for (const repository of CONFIG.bitbucket.repositories) {
    repositories.push(await fetchRepositoryReport(repository, dateRange));
  }

  return {
    date: dateRange.dateString,
    workspace: CONFIG.bitbucket.workspace,
    repositories: repositories.map(repo => ({
      ...repo,
      pullRequests: repo.pullRequests.filter(pr => matchesReportAuthor(pr.author, pr.title, pr.description)),
    })),
  };
}

async function sendDailyReport(options = {}) {
  const {
    trigger = 'manual',
    forceSend = false,
    notifyTelegram = true,
  } = options;

  validateConfig();

  const reportDate = getReportDate();
  const sentEntry = getSentLogEntry(reportDate);
  if (!forceSend && sentEntry) {
    const message = buildAlreadySentMessage(reportDate, sentEntry);
    log(message);
    return { sent: false, skipped: true, message };
  }

  await verifyBitbucketAuth();
  const report = await buildDailyReport();
  const pullRequestCount = report.repositories.reduce((sum, repo) => sum + repo.pullRequests.length, 0);

  await sendEmailReport(report);
  markSent(reportDate, trigger);

  const message = `Today's updates sent for ${formatReportHeadingDate(reportDate)}. Matching updates for ${CONFIG.reportAuthorMatch}: ${pullRequestCount}.`;
  log(message);

  if (notifyTelegram && telegramBot && CONFIG.telegram.chatId) {
    await telegramBot.sendMessage(CONFIG.telegram.chatId, message);
  }

  return { sent: true, skipped: false, message, report };
}

async function runStartupChecks() {
  validateConfig();

  log('Starting Daily Task Report service.', {
    workspace: CONFIG.bitbucket.workspace,
    repositories: CONFIG.bitbucket.repositories,
    authIdentity: CONFIG.bitbucket.email || '(missing)',
    tokenPreview: maskToken(CONFIG.bitbucket.apiToken),
    cronSchedule: CONFIG.cronSchedule,
    timezone: CONFIG.timezone,
  });

  await verifyBitbucketAuth();
  await createTransporter().verify();
  log('Gmail SMTP verification succeeded.');
}

let telegramBot = null;

function scheduleDailyReport() {
  cron.schedule(
    CONFIG.cronSchedule,
    async () => {
      log('Cron triggered daily report send.');
      try {
        await sendDailyReport({ trigger: 'cron' });
      } catch (error) {
        log('Cron send failed.', error.message);
      }
    },
    { timezone: CONFIG.timezone }
  );

  log(`Cron job scheduled for ${CONFIG.cronSchedule} (${CONFIG.timezone}).`);
}

async function main() {
  const args = new Set(process.argv.slice(2));

  if (args.has('--send')) {
    const result = await sendDailyReport({
      trigger: 'manual',
      forceSend: args.has('--force'),
      notifyTelegram: false,
    });
    console.log(result.message);
    return;
  }

  if (args.has('--check-auth')) {
    validateConfig();
    const workspace = await verifyBitbucketAuth();
    console.log(`Bitbucket auth ok for workspace: ${workspace}`);
    return;
  }

  await runStartupChecks();
  telegramBot = createTelegramBot();
  scheduleDailyReport();
}

main().catch(error => {
  log('Application startup failed.', error.stack || error.message);
  process.exit(1);
});
