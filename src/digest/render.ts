/** Digest rendering: plain text plus email-client-safe HTML (tables, inline styles). */
import type { AccountHealth, WaitingThread } from './core.js';

const OTHERS_MAX = 40;   // the full list always lands in the report JSON

export interface RenderOptions {
  now: Date;
  lookbackDays: number;
  handledTag: string;
  reportPath: string;
  accentColor: string;
  boardUrl?: string;
  dismissUrl?: string;
}

export function renderDigestText(waiting: WaitingThread[], health: AccountHealth[],
                                 o: RenderOptions): { subject: string; text: string } {
  const day = o.now.toISOString().slice(0, 10);
  const subject = waiting.length === 0 ? `Inbound Digest ${day} - all clear` : `Inbound Digest ${day} - ${waiting.length} waiting`;
  const lines: string[] = ['MAILBOX HEALTH'];
  for (const h of health) {
    lines.push(h.ok
      ? `  OK    ${h.name} (${h.email}) - ${h.scanned} scanned, ${h.waiting} waiting`
      : `  RED   ${h.name} (${h.email}) - ${h.error ?? 'unreachable'}`);
  }
  lines.push('');

  const contacts = waiting.filter((w) => w.contact !== null);
  const others = waiting.filter((w) => w.contact === null);
  const item = (w: WaitingThread, withLink: boolean) => {
    const who = w.contact ? `${w.contact} (${w.senderName})` : w.senderName;
    lines.push(`${String(w.ageDays).padStart(3)}d  ${who} <${w.senderEmail}>`);
    lines.push(`      ${w.subject}  [${w.accountName}]`);
    if (w.snippet) lines.push(`      "${w.snippet}"`);
    if (withLink && w.link) lines.push(`      open: ${w.link}`);
    lines.push('');
  };

  if (waiting.length === 0) {
    lines.push('All clear. Nobody is waiting on a reply.');
  } else {
    if (contacts.length) {
      lines.push(`CONTACTS WAITING (${contacts.length}, oldest first)`, '');
      contacts.forEach((w) => item(w, true));
    }
    if (others.length) {
      lines.push(`OTHERS (${others.length}, oldest first${others.length > OTHERS_MAX ? `, showing ${OTHERS_MAX}` : ''})`, '');
      others.slice(0, OTHERS_MAX).forEach((w) => item(w, true));
      if (others.length > OTHERS_MAX) lines.push(`...and ${others.length - OTHERS_MAX} more in ${o.reportPath}`, '');
    }
    lines.push(`Answered another way? Tag the thread "${o.handledTag}" and it drops off next run. A reply clears it automatically.`);
  }
  lines.push('');
  lines.push(`Scanned ${health.reduce((n, h) => n + h.scanned, 0)} messages across `
    + `${health.filter((h) => h.ok).length}/${health.length} accounts, ${o.lookbackDays}-day window.`);
  lines.push('This digest always sends. A missing digest means the scan failed.');
  return { subject, text: lines.join('\n') };
}

export function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function ageBadge(days: number): string {
  const bg = days >= 14 ? '#8A2020' : days >= 4 ? '#B4541A' : '#55524B';
  return `<td width="52" align="center" valign="top" style="padding:10px 0 0 0">`
    + `<div style="background:${bg};color:#ffffff;border-radius:6px;font:bold 13px Arial;padding:6px 0;width:46px">${days}d</div></td>`;
}

export function renderDigestHtml(waiting: WaitingThread[], health: AccountHealth[], o: RenderOptions): string {
  const day = o.now.toISOString().slice(0, 10);
  const P = esc(o.accentColor);
  const contacts = waiting.filter((w) => w.contact !== null);
  const others = waiting.filter((w) => w.contact === null);

  const healthRows = health.map((h) => {
    const dot = h.ok ? '#2E6B3E' : '#8A2020';
    const detail = h.ok
      ? `${h.scanned} scanned &middot; <b>${h.waiting} waiting</b> &middot; ${h.droppedAutomated} bulk dropped`
      : esc(h.error ?? 'unreachable');
    return `<tr><td width="14" style="font-size:13px;color:${dot};padding:2px 6px 2px 0">&#9679;</td>`
      + `<td style="font:13px Arial;color:#26221E;padding:2px 0"><b>${esc(h.name)}</b> <span style="color:#6A6670">${detail}</span></td></tr>`;
  }).join('');

  const card = (w: WaitingThread) => {
    const who = w.contact
      ? `<span style="color:${P}">${esc(w.contact)}</span> <span style="color:#6A6670;font-weight:normal">(${esc(w.senderName)})</span>`
      : esc(w.senderName);
    const open = w.link
      ? ` &nbsp;<a href="${esc(w.link)}" style="color:${P};font:bold 12px Arial;text-decoration:none;border:1px solid ${P};border-radius:4px;padding:2px 8px">open</a>`
      : '';
    const done = o.dismissUrl
      ? ` &nbsp;<a href="${esc(o.dismissUrl)}?tid=${encodeURIComponent(w.threadId)}&amp;d=${encodeURIComponent(w.newestInboundDate)}&amp;who=${encodeURIComponent(w.contact ?? w.senderName)}"`
        + ` style="color:#2E6B3E;font:bold 12px Arial;text-decoration:none;border:1px solid #2E6B3E;border-radius:4px;padding:2px 8px">&#10003; done</a>`
      : '';
    return `<tr><td colspan="2" style="border-top:1px solid #E4E0DA;font-size:1px;line-height:1px">&nbsp;</td></tr>`
      + `<tr>${ageBadge(w.ageDays)}<td style="padding:8px 0 10px 10px">`
      + `<div style="font:bold 14px Arial;color:#26221E">${who}${open}${done}</div>`
      + `<div style="font:13px Arial;color:#26221E;padding-top:2px">${esc(w.subject)} <span style="color:#9B968F">[${esc(w.accountName)}]</span></div>`
      + (w.snippet ? `<div style="font:italic 12px Arial;color:#6A6670;padding-top:3px">&ldquo;${esc(w.snippet)}&rdquo;</div>` : '')
      + `</td></tr>`;
  };

  const section = (title: string, count: string) =>
    `<tr><td colspan="2" style="padding:18px 0 6px 0"><div style="font:bold 11px Arial;letter-spacing:2px;color:#ffffff;background:${P};`
    + `border-radius:4px;padding:5px 10px;display:inline-block">${title} &nbsp;${count}</div></td></tr>`;

  let body = '';
  if (waiting.length === 0) {
    body = `<tr><td style="font:15px Arial;color:#2E6B3E;padding:16px 0"><b>All clear.</b> Nobody is waiting on a reply.</td></tr>`;
  } else {
    if (contacts.length) {
      body += section('CONTACTS WAITING', `${contacts.length}, oldest first`);
      contacts.forEach((w) => { body += card(w); });
    }
    if (others.length) {
      body += section('OTHERS', `${others.length}${others.length > OTHERS_MAX ? `, showing ${OTHERS_MAX}` : ''}`);
      others.slice(0, OTHERS_MAX).forEach((w) => { body += card(w); });
      if (others.length > OTHERS_MAX) {
        body += `<tr><td colspan="2" style="font:12px Arial;color:#6A6670;padding:8px 0">&hellip;and ${others.length - OTHERS_MAX} more in ${esc(o.reportPath)}</td></tr>`;
      }
    }
  }

  const scanned = health.reduce((n, h) => n + h.scanned, 0);
  const okCount = health.filter((h) => h.ok).length;
  const board = o.boardUrl
    ? `<tr><td style="background:${P};padding:8px 22px"><a href="${esc(o.boardUrl)}" style="font:bold 12px Arial;color:#ffffff;text-decoration:none">&#9654; open the triage board</a></td></tr>`
    : '';
  return `<div style="background:#F4F2EF;padding:18px 0">`
    + `<table cellpadding="0" cellspacing="0" border="0" align="center" width="680" style="max-width:680px;background:#ffffff;border:1px solid #E0DCD6;border-radius:8px">`
    + `<tr><td style="background:#26221E;border-radius:8px 8px 0 0;padding:14px 22px">`
    + `<span style="font:bold 17px Arial;color:#ffffff;letter-spacing:1px">INBOUND DIGEST</span>`
    + `<span style="font:13px Arial;color:#C9C4BD">&nbsp;&nbsp;${day}</span>`
    + `<span style="float:right;font:bold 14px Arial;color:#ffffff;background:${waiting.length ? P : '#2E6B3E'};border-radius:12px;padding:3px 12px">${waiting.length ? `${waiting.length} waiting` : 'all clear'}</span>`
    + `</td></tr>${board}`
    + `<tr><td style="padding:14px 22px 4px 22px"><table cellpadding="0" cellspacing="0" border="0" width="100%">`
    + `<tr><td colspan="2" style="font:bold 11px Arial;letter-spacing:2px;color:#6A6670;padding-bottom:4px">MAILBOX HEALTH</td></tr>${healthRows}</table></td></tr>`
    + `<tr><td style="padding:0 22px 8px 22px"><table cellpadding="0" cellspacing="0" border="0" width="100%">${body}</table></td></tr>`
    + `<tr><td style="background:#F4F2EF;border-radius:0 0 8px 8px;border-top:1px solid #E0DCD6;padding:12px 22px">`
    + `<div style="font:12px Arial;color:#6A6670">Answered another way? Tag the thread <b>${esc(o.handledTag)}</b> and it drops off next run. A reply clears it automatically.</div>`
    + `<div style="font:11px Arial;color:#9B968F;padding-top:6px">Scanned ${scanned} messages across ${okCount}/${health.length} accounts, ${o.lookbackDays}-day window &middot; this digest always sends; a missing digest means the scan failed.</div>`
    + `</td></tr></table></div>`;
}
