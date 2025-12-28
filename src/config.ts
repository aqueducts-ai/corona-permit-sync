function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function optionalEnv(name: string, defaultValue: string): string {
  return process.env[name] || defaultValue;
}

export const config = {
  // Server
  port: parseInt(optionalEnv('PORT', '3000'), 10),
  nodeEnv: optionalEnv('NODE_ENV', 'development'),

  // Railway Postgres (state storage)
  databaseUrl: requireEnv('DATABASE_URL'),

  // Threefold API
  threefoldApiUrl: requireEnv('THREEFOLD_API_URL'),
  threefoldApiToken: requireEnv('THREEFOLD_API_TOKEN'),
  threefoldOrgId: requireEnv('THREEFOLD_ORG_ID'),

  // SendGrid webhook verification (optional)
  sendgridWebhookSecret: process.env.SENDGRID_WEBHOOK_SECRET,

  // Corona organization ID in Threefold
  coronaOrgId: requireEnv('THREEFOLD_ORG_ID'),

  // OpenAI for LLM-based ticket matching (optional - if not set, LLM matching is disabled)
  openaiApiKey: process.env.OPENAI_API_KEY || '',
  openaiModel: optionalEnv('OPENAI_MODEL', 'gpt-4o-mini'),

  // Matching configuration
  matchingRadiusMeters: parseInt(optionalEnv('MATCHING_RADIUS_METERS', '100'), 10),
  matchingLookbackDays: parseInt(optionalEnv('MATCHING_LOOKBACK_DAYS', '90'), 10),
  // LLM matching auto-disabled if no API key
  llmMatchingEnabled: !!process.env.OPENAI_API_KEY && optionalEnv('LLM_MATCHING_ENABLED', 'true') === 'true',

  // Ticket updates - set to 'false' to disable Threefold API updates (dry run mode)
  // When disabled: still does DB upserts and logs changes, but skips ticket close/comment API calls
  ticketUpdatesEnabled: optionalEnv('TICKET_UPDATES_ENABLED', 'true') === 'true',

  // Permit updates - set to 'false' to disable Threefold Permits API updates (dry run mode)
  // When disabled: still does DB upserts and logs changes, but skips permit create/update API calls
  permitUpdatesEnabled: optionalEnv('PERMIT_UPDATES_ENABLED', 'true') === 'true',

  // Workflow step IDs for Corona
  closeViolationStepId: parseInt(optionalEnv('THREEFOLD_CLOSE_STEP_ID', '41'), 10),
} as const;
