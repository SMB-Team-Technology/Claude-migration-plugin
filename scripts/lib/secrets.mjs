const PATTERNS = [
  ['an Anthropic API key', /sk-ant-[A-Za-z0-9_-]{20,}/],
  ['an API secret key', /\bsk-[A-Za-z0-9]{32,}/],
  ['an AWS access key', /\bAKIA[0-9A-Z]{16}\b/],
  ['a GitHub token', /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})/],
  ['a Slack token', /\bxox[abprs]-[A-Za-z0-9-]{10,}/],
  ['a Google API key', /\bAIza[0-9A-Za-z_-]{35}\b/],
  ['a private key', /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/],
];

/** Names the first kind of credential found in `text`, or null. */
export const findSecret = (text) => {
  const hit = PATTERNS.find(([, pattern]) => pattern.test(text));
  return hit ? hit[0] : null;
};
