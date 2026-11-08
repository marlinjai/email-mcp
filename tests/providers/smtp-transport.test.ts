import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import net from 'node:net';
import { createSmtpTransport, sendViaSmtp } from '../../src/providers/imap/smtp.js';

/**
 * Runs the real nodemailer SMTP client (no mocks) against a minimal in-process
 * SMTP server, so a nodemailer upgrade is proven on the actual send path:
 * connect, EHLO, AUTH, MAIL FROM, RCPT TO, DATA.
 */
interface Received {
  auth: string[];
  mailFrom: string;
  rcptTo: string[];
  data: string;
}

function startFakeSmtpServer(): Promise<{ port: number; received: Received[]; close: () => Promise<void> }> {
  const received: Received[] = [];
  const server = net.createServer((socket) => {
    const current: Received = { auth: [], mailFrom: '', rcptTo: [], data: '' };
    let buffer = '';
    let inData = false;
    let awaitingAuthLines = 0;
    const reply = (line: string) => socket.write(`${line}\r\n`);
    reply('220 fake.smtp.test ESMTP');
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      let index: number;
      while ((index = buffer.indexOf('\r\n')) !== -1) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        if (inData) {
          if (line === '.') {
            inData = false;
            received.push({ ...current, rcptTo: [...current.rcptTo] });
            reply('250 2.0.0 Ok: queued as FAKE123');
          } else {
            current.data += `${line.startsWith('..') ? line.slice(1) : line}\r\n`;
          }
          continue;
        }
        if (awaitingAuthLines > 0) {
          current.auth.push(Buffer.from(line, 'base64').toString('utf8'));
          awaitingAuthLines -= 1;
          reply(awaitingAuthLines > 0 ? `334 ${Buffer.from('Password:').toString('base64')}` : '235 2.7.0 Authentication successful');
          continue;
        }
        const command = line.toUpperCase();
        if (command.startsWith('EHLO')) {
          socket.write('250-fake.smtp.test\r\n250-AUTH PLAIN LOGIN\r\n250 8BITMIME\r\n');
        } else if (command.startsWith('AUTH PLAIN')) {
          const payload = line.split(' ')[2];
          if (payload) {
            current.auth.push(Buffer.from(payload, 'base64').toString('utf8'));
            reply('235 2.7.0 Authentication successful');
          } else {
            awaitingAuthLines = 1;
            reply('334 ');
          }
        } else if (command.startsWith('AUTH LOGIN')) {
          awaitingAuthLines = 2;
          reply(`334 ${Buffer.from('Username:').toString('base64')}`);
        } else if (command.startsWith('MAIL FROM:')) {
          current.mailFrom = line.slice('MAIL FROM:'.length).trim();
          reply('250 2.1.0 Ok');
        } else if (command.startsWith('RCPT TO:')) {
          current.rcptTo.push(line.slice('RCPT TO:'.length).trim());
          reply('250 2.1.5 Ok');
        } else if (command === 'DATA') {
          inData = true;
          reply('354 End data with <CR><LF>.<CR><LF>');
        } else if (command === 'QUIT') {
          reply('221 2.0.0 Bye');
          socket.end();
        } else {
          reply('250 Ok');
        }
      }
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as net.AddressInfo;
      resolve({
        port,
        received,
        close: () => new Promise<void>((done) => server.close(() => done())),
      });
    });
  });
}

describe('SMTP send through the real nodemailer transport', () => {
  let fake: Awaited<ReturnType<typeof startFakeSmtpServer>>;

  beforeAll(async () => {
    fake = await startFakeSmtpServer();
  });

  afterAll(async () => {
    await fake.close();
  });

  it('authenticates and delivers a multipart message with an attachment', async () => {
    const transport = createSmtpTransport('sender@example.test', {
      host: '127.0.0.1',
      port: 993,
      tls: true,
      smtpHost: '127.0.0.1',
      smtpPort: fake.port,
      password: 'app-password-for-test',
    });

    try {
      const messageId = await sendViaSmtp(
        transport,
        { name: 'Sender, Test', address: 'sender@example.test' },
        {
          to: [{ name: 'Recipient', email: 'recipient@example.test' }],
          cc: [{ email: 'cc@example.test' }],
          subject: 'Upgrade proof',
          body: { html: '<p>Hello <b>world</b></p>' },
          attachments: [{ filename: 'note.txt', content: Buffer.from('attached text'), contentType: 'text/plain' }],
        },
      );

      expect(messageId).toMatch(/^<.+@.+>$/);
      expect(fake.received).toHaveLength(1);
      const [mail] = fake.received;
      expect(mail.auth.join('\n')).toContain('sender@example.test');
      expect(mail.auth.join('\n')).toContain('app-password-for-test');
      expect(mail.mailFrom).toBe('<sender@example.test>');
      expect(mail.rcptTo).toEqual(['<recipient@example.test>', '<cc@example.test>']);
      expect(mail.data).toContain('Subject: Upgrade proof');
      expect(mail.data).toContain('"Sender, Test" <sender@example.test>');
      expect(mail.data).toMatch(/Content-Type: multipart\/alternative/);
      expect(mail.data).toContain('Content-Type: text/plain');
      expect(mail.data).toContain('Content-Type: text/html');
      expect(mail.data).toMatch(/filename="?note\.txt"?/);
    } finally {
      transport.close();
    }
  });
});
