import net from "node:net";
import tls from "node:tls";

/**
 * Email sending seam — the email counterpart of the SMS seam (sms.ts).
 * Domain code talks to the EmailSender interface only; the driver is
 * selected by env:
 *
 *  - `smtp` — a minimal, dependency-free SMTP client (plain Node
 *             net/tls: EHLO, STARTTLS when offered, AUTH LOGIN,
 *             MAIL/RCPT/DATA). Works with any SMTP provider — a Google
 *             Workspace / Gmail app password for RRsFinest1@gmail.com,
 *             or a transactional provider's SMTP relay. Selected with
 *             EMAIL_PROVIDER=smtp and ALL of SMTP_HOST, SMTP_USER,
 *             SMTP_PASS, EMAIL_FROM set.
 *  - anything else (including EMAIL_PROVIDER unset, or smtp selected
 *    with any variable missing) — the UNCONFIGURED sender. Its send()
 *    throws EmailNotConfiguredError. Unlike the SMS mock, there is NO
 *    fake-success email driver: a quote or invoice email that cannot
 *    really be sent must fail loud (the notification row records the
 *    failure and health reports email_provider="unconfigured"), never
 *    silently pretend the customer was emailed (Nelly, 2026-11-23).
 */

export interface EmailMessage {
  /** Destination email address. */
  to: string;
  subject: string;
  /** Plain-text body. */
  body: string;
}

export interface EmailSendResult {
  providerMessageId: string;
}

export interface EmailSender {
  /** "smtp" | "unconfigured" — a name, never a credential. Health reports it. */
  readonly name: string;
  send(message: EmailMessage): Promise<EmailSendResult>;
}

export class EmailNotConfiguredError extends Error {
  readonly code = "EMAIL_NOT_CONFIGURED";
  constructor(detail: string) {
    super(
      `Email is not configured (${detail}). Set EMAIL_PROVIDER=smtp plus ` +
        `SMTP_HOST, SMTP_USER, SMTP_PASS and EMAIL_FROM to send customer email.`
    );
    this.name = "EmailNotConfiguredError";
  }
}

export interface SmtpConfig {
  host: string;
  port: number;
  /** Implicit TLS (SMTPS, usually port 465). Otherwise STARTTLS is used when offered. */
  secure: boolean;
  user: string;
  pass: string;
  from: string;
}

/**
 * The SMTP config, or null when any required variable is missing.
 * SMTP_PORT defaults to 465; SMTP_SECURE defaults from the port
 * (465 = implicit TLS) and can be forced with "true"/"false".
 */
export function loadSmtpConfig(
  env: Record<string, string | undefined>
): SmtpConfig | null {
  const host = env.SMTP_HOST?.trim();
  const user = env.SMTP_USER?.trim();
  const pass = env.SMTP_PASS;
  const from = env.EMAIL_FROM?.trim();
  if (!host || !user || !pass || !from) return null;
  const portRaw = Number(env.SMTP_PORT ?? "465");
  const port = Number.isInteger(portRaw) && portRaw > 0 ? portRaw : 465;
  const secureRaw = env.SMTP_SECURE?.trim().toLowerCase();
  const secure = secureRaw ? secureRaw === "true" : port === 465;
  return { host, port, secure, user, pass, from };
}

class UnconfiguredEmailSender implements EmailSender {
  readonly name = "unconfigured";
  constructor(private readonly detail: string) {}
  async send(_message: EmailMessage): Promise<EmailSendResult> {
    throw new EmailNotConfiguredError(this.detail);
  }
}

/** One SMTP response: the final line of a (possibly multi-line) reply. */
interface SmtpResponse {
  code: number;
  text: string;
}

/**
 * Minimal line-oriented SMTP session over a connected socket. Reads
 * are buffered; each command resolves with the server's final reply
 * line (a reply ends when a line matches /^\d{3} /).
 */
class SmtpSession {
  private buffer = "";
  private waiters: ((r: SmtpResponse) => void)[] = [];
  private lines: string[] = [];

  constructor(private readonly socket: net.Socket | tls.TLSSocket) {
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      this.buffer += chunk;
      let idx: number;
      while ((idx = this.buffer.indexOf("\r\n")) >= 0) {
        const line = this.buffer.slice(0, idx);
        this.buffer = this.buffer.slice(idx + 2);
        this.lines.push(line);
        if (/^\d{3} /.test(line) || /^\d{3}$/.test(line)) {
          const text = this.lines.join("\n");
          this.lines = [];
          const waiter = this.waiters.shift();
          if (waiter) waiter({ code: Number(line.slice(0, 3)), text });
        }
      }
    });
  }

  nextResponse(): Promise<SmtpResponse> {
    return new Promise(resolve => this.waiters.push(resolve));
  }

  async command(command: string, expect: number[]): Promise<SmtpResponse> {
    const pending = this.nextResponse();
    this.socket.write(command + "\r\n");
    const res = await pending;
    if (!expect.includes(res.code)) {
      throw new Error(
        `SMTP command failed (${command.split(" ")[0]}): ${res.code} ${res.text.split("\n").pop()}`
      );
    }
    return res;
  }

  writeRaw(data: string): void {
    this.socket.write(data);
  }

  destroy(): void {
    this.socket.destroy();
  }
}

function connectSocket(config: SmtpConfig): Promise<net.Socket | tls.TLSSocket> {
  return new Promise((resolve, reject) => {
    const socket = config.secure
      ? tls.connect({ host: config.host, port: config.port, servername: config.host })
      : net.connect({ host: config.host, port: config.port });
    const onError = (err: Error) => reject(err);
    socket.once("error", onError);
    socket.once(config.secure ? "secureConnect" : "connect", () => {
      socket.removeListener("error", onError);
      socket.setTimeout(20_000, () => socket.destroy(new Error("SMTP timeout")));
      resolve(socket as net.Socket | tls.TLSSocket);
    });
  });
}

export class SmtpEmailSender implements EmailSender {
  readonly name = "smtp";
  constructor(private readonly config: SmtpConfig) {}

  async send(message: EmailMessage): Promise<EmailSendResult> {
    const { config } = this;
    let socket = await connectSocket(config);
    let session = new SmtpSession(socket);
    try {
      const greeting = await session.nextResponse();
      if (greeting.code !== 220) {
        throw new Error(`SMTP greeting failed: ${greeting.code} ${greeting.text}`);
      }
      let ehlo = await session.command(`EHLO ${config.host}`, [250]);

      // Opportunistic STARTTLS on plain connections when the server
      // offers it (providers on port 587 require it before AUTH).
      if (!config.secure && /\bSTARTTLS\b/.test(ehlo.text)) {
        await session.command("STARTTLS", [220]);
        const upgraded = tls.connect({ socket, servername: config.host });
        await new Promise<void>((resolve, reject) => {
          upgraded.once("secureConnect", resolve);
          upgraded.once("error", reject);
        });
        socket = upgraded;
        session = new SmtpSession(socket);
        ehlo = await session.command(`EHLO ${config.host}`, [250]);
      }

      await session.command("AUTH LOGIN", [334]);
      await session.command(
        Buffer.from(config.user, "utf8").toString("base64"),
        [334]
      );
      await session.command(
        Buffer.from(config.pass, "utf8").toString("base64"),
        [235]
      );
      await session.command(`MAIL FROM:<${config.from}>`, [250]);
      await session.command(`RCPT TO:<${message.to}>`, [250, 251]);
      await session.command("DATA", [354]);
      const headers = [
        `From: ${config.from}`,
        `To: ${message.to}`,
        `Subject: ${message.subject.replace(/[\r\n]+/g, " ")}`,
        "MIME-Version: 1.0",
        'Content-Type: text/plain; charset="utf-8"',
        "",
        ""
      ].join("\r\n");
      const body = message.body
        .replace(/\r?\n/g, "\r\n")
        .replace(/^\./gm, "..");
      const pending = session.nextResponse();
      session.writeRaw(headers + body + "\r\n.\r\n");
      const dataRes = await pending;
      if (dataRes.code !== 250) {
        throw new Error(`SMTP DATA failed: ${dataRes.code} ${dataRes.text}`);
      }
      const idMatch = dataRes.text.match(/id=([^\s]+)/i) ??
        dataRes.text.match(/\b([A-Za-z0-9._-]{8,})\s*$/);
      await session.command("QUIT", [221]).catch(() => undefined);
      return { providerMessageId: idMatch ? idMatch[1] : "smtp-accepted" };
    } finally {
      session.destroy();
    }
  }
}

/**
 * Selects the email driver from env. SMTP is used only when explicitly
 * selected AND fully configured; every other state is the unconfigured
 * sender, whose sends throw — email can never fake-send.
 */
export function createEmailSender(
  env: Record<string, string | undefined> = process.env
): EmailSender {
  const provider = env.EMAIL_PROVIDER?.trim().toLowerCase();
  if (provider === "smtp") {
    const config = loadSmtpConfig(env);
    if (config) return new SmtpEmailSender(config);
    return new UnconfiguredEmailSender(
      "EMAIL_PROVIDER=smtp but SMTP_HOST/SMTP_USER/SMTP_PASS/EMAIL_FROM are not all set"
    );
  }
  return new UnconfiguredEmailSender(
    provider ? `unknown EMAIL_PROVIDER "${provider}"` : "EMAIL_PROVIDER is not set"
  );
}

/** Basic shape check for a customer email address (intake validates fully). */
export function isEmailAddress(raw: string | null | undefined): raw is string {
  return !!raw && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw.trim());
}
