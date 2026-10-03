import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AccountManager } from '../account-manager.js';
import type { SendEmailParams } from '../providers/provider.js';
import type { Contact, Email } from '../models/types.js';
import { AttachmentsSchema, assertAttachmentTotal, resolveAttachments } from './attachments.js';

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

function messageIds(headerValue: string | undefined): string[] {
  return headerValue?.match(/<[^<>\s]+>/g) ?? [];
}

/**
 * What makes a new message a reply to `original`: In-Reply-To and References
 * built from its Message-ID (after the References it already had), the Gmail
 * thread and the Graph item id. Without a Message-ID header there is nothing
 * to point In-Reply-To at, so no headers are set; Outlook still threads
 * through the Graph id.
 */
function replyThreading(original: Email): Pick<SendEmailParams, 'inReplyTo' | 'references' | 'threadId' | 'replyToGraphId'> {
  const [messageId] = messageIds(original.headers?.['message-id']);
  if (!messageId) return { threadId: original.threadId, replyToGraphId: original.id };
  const earlier = messageIds(original.headers?.['references']).filter((id) => id !== messageId);
  return {
    inReplyTo: messageId,
    references: [...earlier, messageId],
    threadId: original.threadId,
    replyToGraphId: original.id,
  };
}

const sameAddress = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** Each address once across To and Cc; the first mention wins, To before Cc. */
function withoutDuplicates(to: Contact[], cc: Contact[] | undefined): { to: Contact[]; cc: Contact[] | undefined } {
  const seen = new Set<string>();
  const firstMention = (c: Contact) => {
    const key = c.email.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  };
  return { to: to.filter(firstMention), cc: cc?.filter(firstMention) };
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
      attachments: AttachmentsSchema,
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
          attachments: resolveAttachments(args.attachments),
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
    'Reply to an existing email, in its thread. With replyAll the reply goes to the original sender and all To and Cc recipients, except the account\'s own address',
    {
      accountId: z.string(),
      emailId: z.string(),
      sourceFolder: z.string().optional().describe('Source folder (required for IMAP/iCloud when email is not in INBOX)'),
      body: BodySchema,
      replyAll: z.boolean().optional(),
      to: z
        .array(ContactSchema)
        .optional()
        .describe('Replace the default To (the original sender). Use it when the original was sent by you, so the reply goes to the real correspondents instead of back to yourself'),
      cc: z.array(ContactSchema).optional().describe('Cc recipients. Replaces any Cc carried over by replyAll'),
      bcc: z.array(ContactSchema).optional(),
      additionalRecipients: z
        .array(ContactSchema)
        .optional()
        .describe('Extra To recipients added to the default or given To (deduplicated by address)'),
      attachments: AttachmentsSchema,
    },
    async (args) => {
      try {
        const provider = await accountManager.getProvider(args.accountId);
        const original = await provider.getEmail(args.emailId, args.sourceFolder);

        // Build subject with Re: prefix (avoid duplicating)
        const subject = original.subject.startsWith('Re: ')
          ? original.subject
          : `Re: ${original.subject}`;

        // Determine recipients
        let to = [original.from];
        let cc: SendEmailParams['cc'];

        if (args.replyAll) {
          // The original sender, "to" and "cc" recipients, minus this
          // account's own address: a reply-all is not meant to mail yourself.
          const own = await accountManager.getAccountEmail(args.accountId);
          const others = (c: Contact) => !own || !sameAddress(c.email, own);
          to = [original.from, ...original.to].filter(others);
          // Nobody else left (a mail you sent to yourself only): reply to the sender.
          if (to.length === 0) to = [original.from];
          cc = original.cc?.filter(others);
        }

        // An empty `to` counts as not given: a reply needs a recipient.
        if (args.to?.length) to = args.to;
        if (args.additionalRecipients?.length) {
          const seen = new Set(to.map((c) => c.email.toLowerCase()));
          for (const r of args.additionalRecipients) {
            if (!seen.has(r.email.toLowerCase())) {
              to = [...to, r];
              seen.add(r.email.toLowerCase());
            }
          }
        }
        if (args.cc !== undefined) cc = args.cc;
        if (args.replyAll) ({ to, cc } = withoutDuplicates(to, cc));

        const params: SendEmailParams = {
          to,
          cc,
          bcc: args.bcc,
          subject,
          body: args.body,
          ...replyThreading(original),
          attachments: resolveAttachments(args.attachments),
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
    'Forward an email to new recipients. The original message\'s attachments are left out unless includeOriginalAttachments is true',
    {
      accountId: z.string(),
      emailId: z.string(),
      to: z.array(ContactSchema),
      cc: z.array(ContactSchema).optional(),
      bcc: z.array(ContactSchema).optional(),
      body: BodySchema.optional(),
      attachments: AttachmentsSchema.describe('Files to attach to the forward. Total size, together with forwarded original attachments, is capped at 25 MB'),
      includeOriginalAttachments: z
        .boolean()
        .optional()
        .describe('Also forward the original message\'s attachments (default false). Leave it off unless the user asked for the files to go along'),
      sourceFolder: z.string().optional().describe('Source folder (required for IMAP/iCloud when email is not in INBOX)'),
    },
    async (args) => {
      try {
        const provider = await accountManager.getProvider(args.accountId);
        const original = await provider.getEmail(args.emailId, args.sourceFolder);

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

        // Opt-in: the files of a mail are not sent on to another address
        // unless the call says so.
        const extra = resolveAttachments(args.attachments) ?? [];
        const forwarded: typeof extra = [];
        if (args.includeOriginalAttachments && original.attachments?.length) {
          const extraBytes = extra.reduce((sum, a) => sum + a.content.length, 0);
          // First by the sizes the message lists, so nothing is downloaded
          // for a forward that is over the cap anyway. Listed sizes can be
          // missing or approximate, so the fetched bytes are counted as well.
          assertAttachmentTotal(extraBytes + original.attachments.reduce((sum, a) => sum + (a.size || 0), 0));
          let bytes = extraBytes;
          for (const att of original.attachments) {
            const fetched = await provider.getAttachment(original.id, att.id, args.sourceFolder);
            bytes += fetched.data.length;
            assertAttachmentTotal(bytes);
            forwarded.push({ filename: att.filename, content: fetched.data, contentType: att.contentType });
          }
        }
        const attachments = [...forwarded, ...extra];

        const params: SendEmailParams = {
          to: args.to,
          cc: args.cc,
          bcc: args.bcc,
          subject,
          body: { text: forwardedText, html: forwardedHtml },
          attachments: attachments.length ? attachments : undefined,
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
    'Create a new email draft. Pass inReplyToEmailId to save it as a reply in that message\'s thread',
    {
      accountId: z.string(),
      to: z.array(ContactSchema),
      subject: z.string(),
      body: BodySchema,
      attachments: AttachmentsSchema,
      inReplyToEmailId: z
        .string()
        .optional()
        .describe('Id of the email this draft replies to. The draft joins that thread (Gmail threadId, Outlook createReply, In-Reply-To/References headers elsewhere)'),
      inReplyToSourceFolder: z
        .string()
        .optional()
        .describe('Folder of the email named in inReplyToEmailId (required for IMAP/iCloud when that email is not in INBOX). The draft itself is saved to Drafts'),
    },
    async (args) => {
      try {
        const provider = await accountManager.getProvider(args.accountId);
        const params: SendEmailParams = {
          to: args.to,
          subject: args.subject,
          body: args.body,
          attachments: resolveAttachments(args.attachments),
        };
        if (args.inReplyToEmailId) {
          Object.assign(params, replyThreading(await provider.getEmail(args.inReplyToEmailId, args.inReplyToSourceFolder)));
        }
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
    'Update an existing email draft in place (to/subject/body). A reply draft stays in its thread. On Gmail and Outlook the draft id is unchanged. On iCloud/generic IMAP there is no in-place update (the old draft is deleted and a new one appended), so the returned id is a NEW id and the old one no longer resolves; always use the id this call returns, not the one you passed in.',
    {
      accountId: z.string(),
      draftId: z.string(),
      to: z.array(ContactSchema),
      subject: z.string(),
      body: BodySchema,
      attachments: AttachmentsSchema.describe(
        "Files to attach. When given, they replace the draft's current attachments; an empty list removes them all. When omitted, Outlook keeps the existing files but Gmail and IMAP drop them (those providers rewrite the whole message), so pass them again to keep them.",
      ),
      sourceFolder: z.string().optional().describe('Source folder (required for IMAP/iCloud when the draft is not in the default Drafts folder)'),
    },
    async (args) => {
      try {
        const provider = await accountManager.getProvider(args.accountId);
        const params: SendEmailParams = {
          to: args.to,
          subject: args.subject,
          body: args.body,
          attachments: resolveAttachments(args.attachments),
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
