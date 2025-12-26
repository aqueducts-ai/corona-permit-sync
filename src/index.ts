import express from 'express';
import { config } from './config.js';
import { webhookRouter } from './routes/webhook.js';
import { initDb } from './state/tracker.js';

const app = express();

// Log all incoming requests
app.use((req, _res, next) => {
  console.log(`[REQUEST] ${req.method} ${req.path} from ${req.ip}`);
  next();
});

// Health check
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// SendGrid webhook route (uses raw body parsing via busboy)
app.use('/webhook', webhookRouter);

// Error handler
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

async function main() {
  console.log('='.repeat(60));
  console.log('CORONA TRAKIT SYNC - Starting up...');
  console.log('='.repeat(60));
  console.log(`Environment: ${config.nodeEnv}`);
  console.log(`Ticket Updates: ${config.ticketUpdatesEnabled ? 'ENABLED' : 'DISABLED (dry run mode)'}`);
  console.log(`LLM Matching: ${config.llmMatchingEnabled ? 'ENABLED' : 'DISABLED'}`);
  if (config.llmMatchingEnabled) {
    console.log(`  Model: ${config.openaiModel}`);
    console.log(`  Search radius: ${config.matchingRadiusMeters}m`);
    console.log(`  Lookback: ${config.matchingLookbackDays} days`);
  }
  console.log('-'.repeat(60));

  // Initialize database
  console.log('[DB] Initializing database schema...');
  await initDb();
  console.log('[DB] Database ready');

  app.listen(config.port, () => {
    console.log('-'.repeat(60));
    console.log(`[SERVER] Listening on port ${config.port}`);
    console.log(`[SERVER] Health check: http://localhost:${config.port}/health`);
    console.log(`[SERVER] Webhook: POST http://localhost:${config.port}/webhook/sendgrid`);
    console.log('='.repeat(60));
  });
}

main().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
