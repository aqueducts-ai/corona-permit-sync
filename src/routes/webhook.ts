import { Router } from 'express';
import busboy from 'busboy';
import { detectReportType, ReportType } from '../parsers/detect-type.js';
import { parseViolationsCsv } from '../parsers/violations.js';
import { parseInspectionsCsv } from '../parsers/inspections.js';
import { parsePermitsCsv } from '../parsers/permits.js';
import { processViolationsSync } from '../sync/violations-sync.js';
import { processInspectionsSync } from '../sync/inspections-sync.js';
import { processPermitsSync } from '../sync/permits-sync.js';

export const webhookRouter = Router();

interface ParsedEmail {
  from: string;
  to: string;
  subject: string;
  attachments: Array<{
    filename: string;
    content: Buffer;
    contentType: string;
  }>;
}

/**
 * POST /webhook/sendgrid
 *
 * Receives inbound email from SendGrid Inbound Parse.
 * Extracts CSV attachments and processes them.
 */
webhookRouter.post('/sendgrid', (req, res) => {
  const email: ParsedEmail = {
    from: '',
    to: '',
    subject: '',
    attachments: [],
  };

  const bb = busboy({ headers: req.headers });

  bb.on('field', (name: string, val: string) => {
    if (name === 'from') email.from = val;
    if (name === 'to') email.to = val;
    if (name === 'subject') email.subject = val;
  });

  bb.on('file', (name: string, file: NodeJS.ReadableStream, info: { filename: string; mimeType: string }) => {
    const chunks: Buffer[] = [];

    file.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
    });

    file.on('end', () => {
      const content = Buffer.concat(chunks);
      email.attachments.push({
        filename: info.filename,
        content,
        contentType: info.mimeType,
      });
    });
  });

  bb.on('finish', async () => {
    const timestamp = new Date().toISOString();
    console.log('');
    console.log('='.repeat(60));
    console.log(`[WEBHOOK] ${timestamp} - Email received`);
    console.log('='.repeat(60));
    console.log(`[WEBHOOK] From: ${email.from}`);
    console.log(`[WEBHOOK] Subject: ${email.subject}`);
    console.log(`[WEBHOOK] Attachments: ${email.attachments.length}`);
    email.attachments.forEach(a => console.log(`  - ${a.filename} (${(a.content.length / 1024).toFixed(1)} KB)`));
    console.log('-'.repeat(60));

    try {
      // Check if this is a permit email (subject contains "permit")
      const isPermitEmail = email.subject.toLowerCase().includes('permit');

      if (isPermitEmail) {
        console.log(`[WEBHOOK] Permit email detected (subject contains "permit")`);
      }

      // Process each CSV attachment
      for (const attachment of email.attachments) {
        if (!attachment.filename.endsWith('.csv')) {
          console.log(`[WEBHOOK] Skipping non-CSV: ${attachment.filename}`);
          continue;
        }

        const csvContent = attachment.content.toString('utf-8');

        // If subject contains "permit", process any CSV as permits
        if (isPermitEmail) {
          console.log(`[WEBHOOK] Processing as permits: ${attachment.filename}`);
          const permits = await parsePermitsCsv(csvContent);
          console.log(`[PARSE] Parsed ${permits.length} permit records`);
          await processPermitsSync(permits);
          continue;
        }

        // Otherwise, use filename-based detection for violations/inspections
        const reportType = detectReportType(attachment.filename);
        console.log(`[WEBHOOK] Processing ${reportType}: ${attachment.filename}`);

        switch (reportType) {
          case ReportType.VIOLATIONS:
            const violations = await parseViolationsCsv(csvContent);
            console.log(`[PARSE] Parsed ${violations.length} violation records`);
            await processViolationsSync(violations);
            break;

          case ReportType.INSPECTIONS:
            const inspections = await parseInspectionsCsv(csvContent);
            console.log(`[PARSE] Parsed ${inspections.length} inspection records`);
            await processInspectionsSync(inspections);
            break;

          case ReportType.PERMITS:
            const permits = await parsePermitsCsv(csvContent);
            console.log(`[PARSE] Parsed ${permits.length} permit records`);
            await processPermitsSync(permits);
            break;

          case ReportType.UNKNOWN:
            console.log(`[WEBHOOK] Unknown report type, skipping: ${attachment.filename}`);
            break;
        }
      }

      console.log('-'.repeat(60));
      console.log(`[WEBHOOK] Processing complete`);
      console.log('='.repeat(60));
      console.log('');
      res.status(200).json({ success: true });
    } catch (error) {
      console.error('[WEBHOOK] Error processing email:', error);
      res.status(500).json({ error: 'Failed to process email' });
    }
  });

  bb.on('error', (err: Error) => {
    console.error('Busboy error:', err);
    res.status(400).json({ error: 'Failed to parse email' });
  });

  req.pipe(bb);
});
