import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AccountManager } from '../account-manager.js';
import type { SendEmailParams } from '../providers/provider.js';

const ContactSchema = z.object({
  email: z.string(),
  name: z.string().optional(),
});

const BodySchema = z.object({
  text: z.string().optional(),
  html: z.string().optional(),
});

function jsonResult(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data) }] };
}

export function registerSendingTools(server: McpServer, accountManager: AccountManager): void {
  // --- email_send ---
  server.tool(
    'email_send',
    'Send a new email',
    {
      accountId: z.string(),
      to: z.array(ContactSchema),
      cc: z.array(ContactSchema).optional(),
      bcc: z.array(ContactSchema).optional(),
      subject: z.string(),
      body: BodySchema,
    },
    async (args) => {
      try {
        const provider = await accountManager.getProvider(args.accountId);
        const params: SendEmailParams = {
          to: args.to,
          cc: args.cc,
          bcc: args.bcc,
          subject: args.subject,
          body: args.body,
        };
        const result = await provider.sendEmail(params);
        return jsonResult(result);
      } catch (error: any) {
        return jsonResult({ error: error.message });
      }
    },
  );

  // --- email_reply ---
  server.tool(
    'email_reply',
    'Reply to an existing email',
    {
      accountId: z.string(),
      emailId: z.string(),
      body: BodySchema,
      replyAll: z.boolean().optional(),
    },
    async (args) => {
      try {
        const provider = await accountManager.getProvider(args.accountId);
        const original = await provider.getEmail(args.emailId);

        const messageId = original.headers?.['message-id'] ?? original.id;

        // Build subject with Re: prefix (avoid duplicating)
        const subject = original.subject.startsWith('Re: ')
          ? original.subject
          : `Re: ${original.subject}`;

        // Determine recipients
        let to = [original.from];
        let cc: SendEmailParams['cc'];

        if (args.replyAll) {
          // Include all original "to" recipients
          to = [original.from, ...original.to];
          // Include original CC recipients
          cc = original.cc;
        }

        const params: SendEmailParams = {
          to,
          cc,
          subject,
          body: args.body,
          inReplyTo: messageId,
          references: [messageId],
        };

        const result = await provider.sendEmail(params);
        return jsonResult(result);
      } catch (error: any) {
        return jsonResult({ error: error.message });
      }
    },
  );

  // --- email_forward ---
  server.tool(
    'email_forward',
    'Forward an email to new recipients',
    {
      accountId: z.string(),
      emailId: z.string(),
      to: z.array(ContactSchema),
      body: BodySchema.optional(),
    },
    async (args) => {
      try {
        const provider = await accountManager.getProvider(args.accountId);
        const original = await provider.getEmail(args.emailId);

        // Build subject with Fwd: prefix (avoid duplicating)
        const subject = original.subject.startsWith('Fwd: ')
          ? original.subject
          : `Fwd: ${original.subject}`;

        // Build forwarded body
        const forwardHeader = [
          '---------- Forwarded message ----------',
          `From: ${original.from.name ? `${original.from.name} <${original.from.email}>` : original.from.email}`,
          `Date: ${original.date}`,
          `Subject: ${original.subject}`,
          `To: ${original.to.map((c) => (c.name ? `${c.name} <${c.email}>` : c.email)).join(', ')}`,
          '',
        ].join('\n');

        const additionalText = args.body?.text ?? '';
        const originalText = original.body.text ?? '';
        const forwardedText = [
          additionalText,
          additionalText ? '\n' : '',
          forwardHeader,
          originalText,
        ].join('');

        let forwardedHtml: string | undefined;
        if (original.body.html || args.body?.html) {
          const additionalHtml = args.body?.html ?? '';
          const originalHtml = original.body.html ?? '';
          forwardedHtml = [
            additionalHtml,
            '<br/><hr/>',
            `<b>---------- Forwarded message ----------</b><br/>`,
            `From: ${original.from.name ? `${original.from.name} &lt;${original.from.email}&gt;` : original.from.email}<br/>`,
            `Date: ${original.date}<br/>`,
            `Subject: ${original.subject}<br/>`,
            `To: ${original.to.map((c) => (c.name ? `${c.name} &lt;${c.email}&gt;` : c.email)).join(', ')}<br/>`,
            '<br/>',
            originalHtml,
          ].join('');
        }

        const params: SendEmailParams = {
          to: args.to,
          subject,
          body: { text: forwardedText, html: forwardedHtml },
        };

        const result = await provider.sendEmail(params);
        return jsonResult(result);
      } catch (error: any) {
        return jsonResult({ error: error.message });
      }
    },
  );

  // --- email_draft_create ---
  server.tool(
    'email_draft_create',
    'Create a new email draft',
    {
      accountId: z.string(),
      to: z.array(ContactSchema),
      subject: z.string(),
      body: BodySchema,
    },
    async (args) => {
      try {
        const provider = await accountManager.getProvider(args.accountId);
        const params: SendEmailParams = {
          to: args.to,
          subject: args.subject,
          body: args.body,
        };
        const result = await provider.createDraft(params);
        return jsonResult(result);
      } catch (error: any) {
        return jsonResult({ error: error.message });
      }
    },
  );

  // --- email_draft_update ---
  server.tool(
    'email_draft_update',
    'Update an existing email draft in place (to/subject/body). On Gmail and Outlook the draft id is unchanged. On iCloud/generic IMAP there is no in-place update — the old draft is deleted and a new one appended — so the returned id is a NEW id and the old one no longer resolves; always use the id this call returns, not the one you passed in.',
    {
      accountId: z.string(),
      draftId: z.string(),
      to: z.array(ContactSchema),
      subject: z.string(),
      body: BodySchema,
      sourceFolder: z.string().optional().describe('Source folder (required for IMAP/iCloud when the draft is not in the default Drafts folder)'),
    },
    async (args) => {
      try {
        const provider = await accountManager.getProvider(args.accountId);
        const params: SendEmailParams = {
          to: args.to,
          subject: args.subject,
          body: args.body,
        };
        const result = await provider.updateDraft(args.draftId, params, args.sourceFolder);
        return jsonResult(result);
      } catch (error: any) {
        return jsonResult({ error: error.message });
      }
    },
  );

  // --- email_draft_list ---
  server.tool(
    'email_draft_list',
    'List email drafts',
    {
      accountId: z.string(),
      limit: z.number().optional(),
      offset: z.number().optional(),
    },
    async (args) => {
      try {
        const provider = await accountManager.getProvider(args.accountId);
        const drafts = await provider.listDrafts(args.limit, args.offset);
        return jsonResult(drafts);
      } catch (error: any) {
        return jsonResult({ error: error.message });
      }
    },
  );
}
