require('dotenv').config();
const axios = require('axios');
const nodemailer = require('nodemailer');
const TelegramBot = require('node-telegram-bot-api');

const workspace = process.env.BITBUCKET_WORKSPACE || 'ascendcap';
const repositories = (process.env.BITBUCKET_REPOSITORIES || 'ascend_los,ascend_internal_app')
  .split(',')
  .map(repo => repo.trim())
  .filter(Boolean);

let cachedRepositoryList = null;

function maskToken(token) {
  if (!token) return '(missing)';
  if (token.length <= 8) return `${token.slice(0, 2)}***`;
  return `${token.slice(0, 4)}***${token.slice(-4)}`;
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

async function listWorkspaceRepositories(bitbucketConfig) {
  if (cachedRepositoryList) {
    return cachedRepositoryList;
  }

  const values = [];
  let url = `https://api.bitbucket.org/2.0/repositories/${workspace}?pagelen=100`;

  while (url) {
    const { data } = await axios.get(url, bitbucketConfig);
    values.push(...(data.values || []));
    url = data.next || null;
  }

  cachedRepositoryList = values;
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

function buildBitbucketErrorMessage(error, repository, suggestions = []) {
  const status = error.response?.status;
  const requiredScopes = error.response?.data?.error?.detail?.required;

  if (status === 403 && Array.isArray(requiredScopes) && requiredScopes.length > 0) {
    return `Missing Bitbucket token scopes: ${requiredScopes.join(', ')}`;
  }

  if (status === 404 && repository) {
    const visibleRepos = Array.isArray(error.visibleRepositories) && error.visibleRepositories.length > 0
      ? ` Visible repos for this token: ${error.visibleRepositories.join(', ')}.`
      : '';
    const suffix = suggestions.length > 0
      ? ` Possible matches in ${workspace}: ${suggestions.join(', ')}.${visibleRepos}`
      : ` Check repo slug and confirm this Atlassian account has access.${visibleRepos}`;
    return `Repository ${workspace}/${repository} not found for this token.${suffix}`;
  }

  return error.message;
}

function logBitbucketDebug(error, context) {
  console.log('       Debug:', JSON.stringify({
    context,
    status: error.response?.status || null,
    statusText: error.response?.statusText || null,
    requestUrl: error.response?.config?.url || error.config?.url || null,
    authIdentity: process.env.BITBUCKET_EMAIL || '(missing)',
    tokenPreview: maskToken(process.env.BITBUCKET_API_TOKEN),
    responseData: error.response?.data || null,
    message: error.message,
  }, null, 2));
}

function describeError(error) {
  return error.response?.data?.description
    || error.response?.data?.error?.message
    || error.code
    || error.message
    || 'Unknown error';
}

async function withRetry(fn, attempts = 3, delayMs = 1000) {
  let lastError = null;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt < attempts) {
        await new Promise(resolve => setTimeout(resolve, delayMs));
      }
    }
  }

  throw lastError;
}

async function fetchIssuesOrEmpty(candidate, bitbucketConfig) {
  try {
    const { data } = await axios.get(
      `https://api.bitbucket.org/2.0/repositories/${workspace}/${candidate}/issues?pagelen=1`,
      bitbucketConfig
    );
    return { data, disabled: false };
  } catch (error) {
    if (error.response?.status === 410) {
      return { data: { values: [] }, disabled: true };
    }
    throw error;
  }
}

async function resolveRepositoryAccess(repository, bitbucketConfig) {
  const candidates = buildRepositoryCandidates(repository);
  let lastError = null;

  for (const candidate of candidates) {
    try {
      const repoResponse = await axios.get(
        `https://api.bitbucket.org/2.0/repositories/${workspace}/${candidate}`,
        bitbucketConfig
      );

      const issuesResult = await fetchIssuesOrEmpty(candidate, bitbucketConfig);

      await axios.get(
        `https://api.bitbucket.org/2.0/repositories/${workspace}/${candidate}/pullrequests?pagelen=1`,
        bitbucketConfig
      );

      return {
        requestedRepository: repository,
        resolvedRepository: candidate,
        fullName: repoResponse.data.full_name,
        issuesDisabled: issuesResult.disabled,
      }
    } catch (error) {
      lastError = error;
      if (error.response?.status && error.response.status !== 404) {
        throw error;
      }
    }
  }

  if (lastError?.response?.status === 404) {
    try {
      const availableRepos = await listWorkspaceRepositories(bitbucketConfig);
      lastError.suggestedRepositories = pickSuggestedRepositories(repository, availableRepos);
      lastError.visibleRepositories = availableRepos
        .map(repo => repo.slug || repo.full_name || '')
        .filter(Boolean)
        .slice(0, 10);
    } catch (_) {
      // Ignore discovery failure and fall back to the original 404.
    }
  }

  throw lastError;
}

async function test() {
  console.log('\n=== Daily Task Report — Configuration Test ===\n');
  let passed = 0;
  let failed = 0;

  async function check(name, fn) {
    try {
      await fn();
      console.log(`  ✅  ${name}`);
      passed += 1;
    } catch (error) {
      console.log(`  ❌  ${name}: ${error.message}`);
      failed += 1;
    }
  }

  await check('BITBUCKET_EMAIL set', () => {
    if (!process.env.BITBUCKET_EMAIL) throw new Error('Missing');
  });

  await check('BITBUCKET_API_TOKEN set', () => {
    if (!process.env.BITBUCKET_API_TOKEN) throw new Error('Missing');
  });

  await check('GMAIL_APP_PASSWORD set', () => {
    if (!process.env.GMAIL_APP_PASSWORD) throw new Error('Missing');
  });

  const bitbucketConfig = {
    auth: {
      username: process.env.BITBUCKET_EMAIL,
      password: process.env.BITBUCKET_API_TOKEN,
    },
    headers: {
      Accept: 'application/json',
      'User-Agent': 'daily-task-report-test/1.0',
    },
    timeout: 30000,
  };

  for (const repository of repositories) {
    await check(`Bitbucket repository access (${repository})`, async () => {
      try {
        const resolved = await resolveRepositoryAccess(repository, bitbucketConfig);
        console.log(`       Repo: ${resolved.fullName}`);
        if (resolved.resolvedRepository !== repository) {
          console.log(`       Using slug: ${resolved.resolvedRepository} (configured: ${repository})`);
        }
        if (resolved.issuesDisabled) {
          console.log('       Issue tracker disabled; continuing with repository + PR access.');
        }
      } catch (error) {
        logBitbucketDebug(error, `${repository} repository access`);
        throw new Error(buildBitbucketErrorMessage(error, repository, error.suggestedRepositories));
      }
    });
  }

  await check('Gmail SMTP connection', async () => {
    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: {
        user: process.env.EMAIL_SENDER,
        pass: process.env.GMAIL_APP_PASSWORD,
      },
    });
    await transporter.verify();
  });

  if (process.env.TELEGRAM_BOT_TOKEN) {
    await check('Telegram bot token valid', async () => {
      try {
        const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: false });
        const me = await withRetry(() => bot.getMe(), 3, 1500);
        console.log(`       Bot name: @${me.username}`);
      } catch (error) {
        throw new Error(describeError(error));
      }
    });
  } else {
    console.log('  ⏭️  Telegram token not set — skipping');
  }

  console.log(`\n  Results: ${passed} passed, ${failed} failed\n`);

  if (failed > 0) {
    console.log('  Fix the issues above, then run npm test again.\n');
    process.exit(1);
  }

  console.log('  All checks passed! Run: npm run send\n');
}

test().catch(error => {
  console.error(error);
  process.exit(1);
});
