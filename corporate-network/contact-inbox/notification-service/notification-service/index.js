import { connect } from 'nats';
import { Resend } from 'resend';
import Anthropic from '@anthropic-ai/sdk';

// Configuration from environment
const NATS_URL = process.env.NATS_URL || 'nats://nats:4222';
const NOTIFICATION_EMAIL = process.env.NOTIFICATION_EMAIL || 'm.oger@roitsystems.ca';
const NOTIFICATION_FROM_EMAIL = process.env.NOTIFICATION_FROM_EMAIL || 'notifications@roitsystems.ca';
const LOG_LEVEL = process.env.LOG_LEVEL || 'info';
const ADMIN_CONSOLE_URL = 'https://pubapi.roitsystems.ca/admin';

// Initialize API clients
const resend = new Resend(process.env.RESEND_API_KEY);
const anthropic = new Anthropic({
  apiKey: process.env.CLAUDE_API_KEY,
});

// Track processed messages to avoid duplicates
const processedMessages = new Set();

// Logging utility
function log(level, message, data = {}) {
  if (['info', 'warn', 'error'].includes(LOG_LEVEL) || level === 'error') {
    const timestamp = new Date().toISOString();
    const logEntry = JSON.stringify({
      timestamp,
      level,
      message,
      ...data,
    });
    console.log(logEntry);
    if (level === 'error' || level === 'warn') {
      console.error(logEntry);
    }
  }
}

// Analyze message with Claude Opus
async function analyzeMessage(message) {
  try {
    console.error(`[CLAUDE] Starting analysis for message ${message._id}`);
    log('info', 'Starting Claude analysis', { messageId: message._id, subject: message.subject });

    const prompt = `You are an elite AI research analyst for RO IT Systems. Your job is to deeply research and analyze this contact form, providing strategic recommendations backed by industry knowledge.

RO IT Systems Core Services:
• Executive & Board Advisory - C-suite guidance, governance, strategic planning
• Risk & Compliance - regulatory, security, operational risk management
• Digital Transformation - modernization, technology strategy, capability building
• Governance & Controls - frameworks, processes, maturity assessment, oversight
• IT Systems Integration - infrastructure consolidation, cloud strategy, platform modernization

CONTACT DETAILS:
From: ${message.name || 'Unknown'} (${message.email})
Subject Line: ${message.subject || 'No subject'}
Company Size Provided: ${message.company_size || 'Not specified'}
Message: ${message.message}

RESEARCH INSTRUCTIONS:
1. Use your knowledge of the company mentioned (if identifiable) - their market position, business model, recent challenges
2. Research the industry sector - what are current challenges, regulations, transformation trends?
3. Infer their technology stack and operational maturity based on language/context clues
4. Cross-reference with RO IT Systems' expertise areas - where is the biggest ROI?
5. Provide competitive/market context - what are peers doing? What's the industry benchmark?

CRITICAL: You must respond with ONLY valid JSON, no other text. Use this exact structure:
{
  "painPoint": "Clear 2-3 sentence statement of their core business challenge",
  "companyResearch": {
    "name": "Company name if identifiable",
    "estimatedSize": "Inferred employee count range or business stage",
    "likelyIndustry": "Inferred industry sector",
    "organizationalMaturity": "Assessment based on language/approach/signals",
    "industryContext": "Current trends, challenges, or regulations in their sector",
    "keyClues": "Signals from the message that informed inferences"
  },
  "competitiveAnalysis": "Brief insight into what competitors/peers are doing in this space",
  "recommendedServices": ["Service 1", "Service 2", "Service 3"],
  "rationale": "3-4 sentences explaining why these services solve their specific problem given their company context and industry trends",
  "immediateOpportunity": "The single highest-value service to propose first with specific context",
  "timeline": "urgent/soon/flexible/unknown",
  "technicalContext": ["Technologies", "platforms", "or frameworks", "they need or mentioned"],
  "marketInsight": "1-2 sentences on market dynamics that make this engagement timely"
}

Return ONLY the JSON object. No explanation, no markdown, just valid JSON.`;

    log('info', 'Claude API: Initiating request', {
      messageId: message._id,
      model: 'claude-opus-4-7',
      maxTokens: 256,
      promptLength: prompt.length,
    });

    let response;
    try {
      response = await anthropic.messages.create({
        model: 'claude-opus-4-7',
        max_tokens: 256,
        messages: [
          {
            role: 'user',
            content: prompt,
          },
        ],
      });

      log('info', 'Claude API: Response received', {
        messageId: message._id,
        stopReason: response.stop_reason,
        inputTokens: response.usage?.input_tokens,
        outputTokens: response.usage?.output_tokens,
        contentType: response.content[0]?.type,
      });
    } catch (apiError) {
      log('error', 'Claude API: Request failed', {
        messageId: message._id,
        error: apiError.message,
        status: apiError.status,
        type: apiError.type,
        code: apiError.code,
        errorName: apiError.constructor.name,
        stack: apiError.stack,
      });
      throw apiError;
    }

    const content = response.content[0].type === 'text' ? response.content[0].text : '{}';
    let analysis;

    try {
      // Try to parse JSON directly first (Claude returned just JSON)
      analysis = JSON.parse(content.trim());
    } catch (parseError) {
      // Fall back to regex extraction if needed
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        try {
          analysis = JSON.parse(jsonMatch[0]);
        } catch (regexParseError) {
          log('warn', 'Claude response parsing failed', {
            messageId: message._id,
            parseError: parseError.message,
            regexParseError: regexParseError.message,
            rawResponse: content.substring(0, 300),
          });
          analysis = null;
        }
      } else {
        log('warn', 'No JSON found in Claude response', {
          messageId: message._id,
          rawResponse: content.substring(0, 300),
        });
        analysis = null;
      }
    }

    // Validate analysis has required fields
    if (!analysis || !analysis.painPoint) {
      analysis = {
        painPoint: message.subject || 'Unable to analyze',
        companyInference: {
          estimatedSize: message.company_size || 'unknown',
          likelyIndustry: 'unknown',
          organizationalMaturity: 'unknown',
          keyClues: 'Insufficient context for inference',
        },
        recommendedServices: [],
        rationale: 'Unable to analyze message content.',
        immediateOpportunity: 'Needs discovery call',
        timeline: 'unknown',
        technicalContext: [],
      };
    }

    console.error(`[CLAUDE] Analysis completed: ${JSON.stringify(analysis)}`);
    log('info', 'Claude analysis completed', {
      messageId: message._id,
      hasCompanyInference: !!analysis.companyInference,
      hasRecommendations: !!analysis.recommendedServices?.length,
      rawResponse: content.substring(0, 200),
    });

    return analysis;
  } catch (error) {
    console.error(`[CLAUDE] ERROR: ${error.message}\n${error.stack}`);
    log('warn', 'Failed to analyze message with Claude', { messageId: message._id, error: error.message });
    return {
      painPoint: message.subject || 'Unable to analyze',
      companySize: message.company_size || 'unknown',
      timeline: 'unknown',
      scope: 'unknown',
      technicalNeeds: [],
      industry: 'unknown',
    };
  }
}

// Send email notification
async function sendEmailNotification(message, analysis) {
  try {
    const technicalContext = analysis.technicalContext?.length > 0
      ? analysis.technicalContext.join(', ')
      : 'Not specified';
    const recommendedServices = analysis.recommendedServices?.length > 0
      ? analysis.recommendedServices.join(', ')
      : 'Not determined';

    const htmlContent = `
<!DOCTYPE html>
<html>
<head>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; color: #333; }
    .container { max-width: 700px; margin: 0 auto; padding: 20px; }
    .header { background: #f5f5f5; padding: 15px; border-radius: 5px; margin-bottom: 20px; }
    .section { margin-bottom: 20px; }
    .label { font-weight: 600; color: #555; }
    .value { color: #333; margin-top: 4px; }
    .intelligence { background: #f0f7ff; padding: 15px; border-left: 4px solid #0066cc; border-radius: 3px; margin-bottom: 15px; }
    .recommendation { background: #f0fff4; padding: 15px; border-left: 4px solid #00a86b; border-radius: 3px; }
    .rec-title { font-weight: 600; color: #00a86b; margin-bottom: 8px; }
    .action-button { display: inline-block; background: #0066cc; color: white; padding: 10px 20px; border-radius: 5px; text-decoration: none; margin-top: 15px; }
    code { background: #f5f5f5; padding: 2px 6px; border-radius: 3px; font-family: monospace; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h2>New Contact Message</h2>
      <p><code>${message._id || 'unknown'}</code></p>
    </div>

    <div class="section">
      <div class="label">From:</div>
      <div class="value">${message.name || 'Unknown'} &lt;${message.email}&gt;</div>
    </div>

    <div class="section">
      <div class="label">Subject:</div>
      <div class="value">${message.subject || '(no subject)'}</div>
    </div>

    <div class="section">
      <div class="label">Company Size:</div>
      <div class="value">${message.company_size || 'Not specified'}</div>
    </div>

    <div class="section">
      <div class="label">Message:</div>
      <div class="value" style="white-space: pre-wrap; word-wrap: break-word;">${message.message}</div>
    </div>

    <div class="intelligence">
      <h3 style="margin-top: 0;">AI Research Analysis</h3>
      <div><span class="label">Core Need:</span> <div class="value">${analysis.painPoint}</div></div>

      <div style="margin-top: 16px;"><span class="label">Company Research:</span></div>
      <div class="value" style="margin-left: 16px; margin-top: 8px;">
        ${analysis.companyResearch?.name ? `• Name: ${analysis.companyResearch.name}<br/>` : ''}
        • Size: ${analysis.companyResearch?.estimatedSize || 'unknown'}<br/>
        • Industry: ${analysis.companyResearch?.likelyIndustry || 'unknown'}<br/>
        • Maturity: ${analysis.companyResearch?.organizationalMaturity || 'unknown'}<br/>
        ${analysis.companyResearch?.industryContext ? `• Industry Context: ${analysis.companyResearch.industryContext}<br/>` : ''}
      </div>

      ${analysis.competitiveAnalysis ? `<div style="margin-top: 12px;"><span class="label">Market Context:</span> <div class="value">${analysis.competitiveAnalysis}</div></div>` : ''}

      <div style="margin-top: 12px;"><span class="label">Technical Context:</span> <div class="value">${technicalContext}</div></div>

      ${analysis.marketInsight ? `<div style="margin-top: 12px;"><span class="label">Market Timing:</span> <div class="value">${analysis.marketInsight}</div></div>` : ''}

      <div style="margin-top: 12px;"><span class="label">Timeline:</span> <div class="value">${analysis.timeline}</div></div>
    </div>

    <div class="recommendation">
      <div class="rec-title">📊 Recommended Services</div>
      <div style="margin-bottom: 12px;"><strong>${analysis.recommendedServices?.join(' • ')}</strong></div>
      <div><span class="label">Why:</span> <div class="value">${analysis.rationale}</div></div>
      <div style="margin-top: 12px;"><span class="label">Start With:</span> <div class="value"><strong>${analysis.immediateOpportunity}</strong></div></div>
    </div>

    <div class="section">
      <div class="label">Received:</div>
      <div class="value">${new Date(message.timestamp).toLocaleString()}</div>
    </div>

    <a href="${ADMIN_CONSOLE_URL}" class="action-button">View in Admin Console</a>
  </div>
</body>
</html>`;

    log('info', 'Resend API: Initiating email send', {
      messageId: message._id,
      from: NOTIFICATION_FROM_EMAIL,
      to: NOTIFICATION_EMAIL,
      subject: `New Contact: ${message.subject || message.name}`,
      htmlLength: htmlContent.length,
    });

    let response;
    try {
      response = await resend.emails.send({
        from: NOTIFICATION_FROM_EMAIL,
        to: NOTIFICATION_EMAIL,
        subject: `New Contact: ${message.subject || message.name}`,
        html: htmlContent,
      });
      log('info', 'Resend API: Response received', {
        messageId: message._id,
        hasError: !!response.error,
        hasData: !!response.data,
      });
    } catch (requestError) {
      log('error', 'Resend API: Network error', {
        messageId: message._id,
        error: requestError.message,
        errorType: requestError.constructor.name,
        code: requestError.code,
        stack: requestError.stack,
      });
      throw requestError;
    }

    if (response.error) {
      log('error', 'Resend API: Server returned error', {
        messageId: message._id,
        error: response.error,
        errorType: typeof response.error,
      });
      return;
    }

    log('info', 'Email notification sent successfully', {
      messageId: message._id,
      recipient: NOTIFICATION_EMAIL,
      emailId: response.data?.id,
      fromEmail: NOTIFICATION_FROM_EMAIL,
    });
  } catch (error) {
    log('error', 'Email send: Unexpected error', {
      messageId: message._id,
      error: error.message,
      errorType: error.constructor.name,
      stack: error.stack,
    });
  }
}

// Send SMS notification (stub for future implementation)
async function sendSmsNotification(message, analysis) {
  if (!process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_PHONE_FROM) {
    return; // Twilio not configured
  }

  // Stub: implement Twilio SMS when credentials available
  log('info', 'SMS notification (not yet implemented)', { messageId: message._id });
}

// Fetch message from CouchDB
async function fetchMessage(messageId) {
  const couchdbUrl = process.env.COUCHDB_URL || 'http://couchdb:5984';
  const user = process.env.COUCHDB_USER || 'admin';
  const password = process.env.COUCHDB_PASSWORD || '';
  const auth = Buffer.from(`${user}:${password}`).toString('base64');
  const url = `${couchdbUrl}/contact_messages/${messageId}`;

  try {
    log('info', 'CouchDB: Initiating fetch', { messageId, url });

    const response = await fetch(url, {
      headers: { Authorization: `Basic ${auth}` },
    });

    log('info', 'CouchDB: Response received', {
      messageId,
      status: response.status,
      statusText: response.statusText,
      contentType: response.headers.get('content-type'),
    });

    if (!response.ok) {
      log('error', 'CouchDB: HTTP error response', {
        messageId,
        status: response.status,
        statusText: response.statusText,
        body: await response.text().catch(() => '(unable to read body)'),
      });
      return null;
    }

    const data = await response.json();
    log('info', 'CouchDB: Successfully parsed response', {
      messageId,
      fields: Object.keys(data),
    });
    return data;
  } catch (error) {
    log('error', 'CouchDB: Network or parsing error', {
      messageId,
      error: error.message,
      errorType: error.constructor.name,
      code: error.code,
      stack: error.stack,
    });
    return null;
  }
}

// Process incoming message
async function processMessage(natsEvent) {
  const messageId = natsEvent.message_id;

  // Skip if already processed
  if (processedMessages.has(messageId)) {
    log('info', 'Skipping duplicate message', { messageId });
    return;
  }

  // Fetch full message from CouchDB
  const message = await fetchMessage(messageId);
  if (!message) {
    log('warn', 'Could not retrieve message for processing', { messageId });
    return;
  }

  // Filter: only process messages from roitsystems.ca
  log('info', 'Fetched message from CouchDB', {
    messageId,
    messageKeys: Object.keys(message),
    hasSourcePage: !!message.source_page,
    sourcePageValue: message.source_page || '(undefined)',
  });

  if (!message.source_page?.includes('roitsystems.ca')) {
    log('info', 'Ignoring message from non-roitsystems.ca source', {
      messageId,
      source: message.source_page,
    });
    return;
  }

  processedMessages.add(messageId);

  try {
    log('info', 'Processing contact message', {
      messageId,
      sender: message.email,
      subject: message.subject,
    });

    // Analyze message content
    const analysis = await analyzeMessage(message);

    // Send notifications
    await sendEmailNotification(message, analysis);
    await sendSmsNotification(message, analysis);

    log('info', 'Message processing completed', { messageId });
  } catch (error) {
    log('error', 'Error processing message', {
      messageId,
      error: error.message,
      stack: error.stack,
    });
  }
}

// Main service
async function main() {
  log('info', 'Starting notification service', {
    natsUrl: NATS_URL,
    notificationEmail: NOTIFICATION_EMAIL,
    couchdbUrl: process.env.COUCHDB_URL || 'http://couchdb:5984',
  });

  try {
    // Connect to NATS
    const nc = await connect({
      servers: NATS_URL,
    });

    log('info', 'Connected to NATS', { servers: NATS_URL });

    // Subscribe to contact messages
    const sub = nc.subscribe('contact.messages.new');

    log('info', 'Subscribed to contact.messages.new');

    // Process messages as they arrive
    (async () => {
      for await (const msg of sub) {
        try {
          const natsEvent = JSON.parse(new TextDecoder().decode(msg.data));
          await processMessage(natsEvent);
        } catch (error) {
          log('error', 'Failed to parse NATS message', { error: error.message });
        }
      }
    })();

    // Graceful shutdown
    process.on('SIGTERM', async () => {
      log('info', 'Received SIGTERM, shutting down gracefully');
      await nc.close();
      process.exit(0);
    });

    process.on('SIGINT', async () => {
      log('info', 'Received SIGINT, shutting down gracefully');
      await nc.close();
      process.exit(0);
    });
  } catch (error) {
    log('error', 'Failed to start notification service', { error: error.message });
    process.exit(1);
  }
}

main();
