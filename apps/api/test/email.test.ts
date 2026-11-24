import net from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  createEmailSender,
  EmailNotConfiguredError,
  loadSmtpConfig,
  SmtpEmailSender
} from "../src/email.js";

/**
 * The email seam (Nelly, 2026-11-23): SMTP when fully configured,
 * fail-loud unconfigured otherwise — there is no fake-send mode.
 */
describe("email seam", () => {
  it("is unconfigured (and throws on send) when EMAIL_PROVIDER is unset", async () => {
    const sender = createEmailSender({});
    expect(sender.name).toBe("unconfigured");
    await expect(
      sender.send({ to: "jane@example.com", subject: "Hi", body: "Body" })
    ).rejects.toBeInstanceOf(EmailNotConfiguredError);
  });

  it("is unconfigured when smtp is selected but a variable is missing", async () => {
    const sender = createEmailSender({
      EMAIL_PROVIDER: "smtp",
      SMTP_HOST: "smtp.example.com",
      SMTP_USER: "user",
      // SMTP_PASS missing
      EMAIL_FROM: "shop@example.com"
    });
    expect(sender.name).toBe("unconfigured");
    await expect(
      sender.send({ to: "jane@example.com", subject: "Hi", body: "Body" })
    ).rejects.toThrow(/EMAIL_NOT_CONFIGURED|not configured/i);
  });

  it("loadSmtpConfig defaults port/secure from the port and honors overrides", () => {
    const base = {
      SMTP_HOST: "smtp.example.com",
      SMTP_USER: "user",
      SMTP_PASS: "secret",
      EMAIL_FROM: "shop@example.com"
    };
    expect(loadSmtpConfig(base)).toMatchObject({ port: 465, secure: true });
    expect(loadSmtpConfig({ ...base, SMTP_PORT: "587" })).toMatchObject({
      port: 587,
      secure: false
    });
    expect(loadSmtpConfig({ ...base, SMTP_HOST: " " })).toBeNull();
  });

  describe("SMTP driver against an in-process fake server", () => {
    let server: net.Server | null = null;
    afterEach(async () => {
      if (server) await new Promise(r => server!.close(r));
      server = null;
    });

    it("delivers a message end-to-end (EHLO, AUTH LOGIN, MAIL/RCPT/DATA)", async () => {
      const received: string[] = [];
      let dataMode = false;
      let dataPayload = "";
      server = net.createServer(socket => {
        socket.setEncoding("utf8");
        socket.write("220 fake ESMTP ready\r\n");
        let buffer = "";
        socket.on("data", chunk => {
          buffer += chunk;
          if (dataMode) {
            dataPayload += chunk;
            if (dataPayload.includes("\r\n.\r\n")) {
              dataMode = false;
              socket.write("250 2.0.0 Ok id=fake-msg-1\r\n");
            }
            return;
          }
          let idx: number;
          while ((idx = buffer.indexOf("\r\n")) >= 0) {
            const line = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 2);
            received.push(line);
            if (line.startsWith("EHLO")) socket.write("250 fake greets\r\n");
            else if (line.startsWith("AUTH LOGIN")) socket.write("334 VXNlcm5hbWU6\r\n");
            else if (line === Buffer.from("smtp-user").toString("base64"))
              socket.write("334 UGFzc3dvcmQ6\r\n");
            else if (line === Buffer.from("smtp-pass").toString("base64"))
              socket.write("235 2.7.0 Accepted\r\n");
            else if (line.startsWith("MAIL FROM")) socket.write("250 2.1.0 Ok\r\n");
            else if (line.startsWith("RCPT TO")) socket.write("250 2.1.5 Ok\r\n");
            else if (line === "DATA") {
              dataMode = true;
              socket.write("354 End data with <CR><LF>.<CR><LF>\r\n");
            } else if (line === "QUIT") socket.write("221 Bye\r\n");
            else socket.write("250 Ok\r\n");
          }
        });
      });
      await new Promise<void>(r => server!.listen(0, "127.0.0.1", r));
      const port = (server.address() as net.AddressInfo).port;

      const sender = new SmtpEmailSender({
        host: "127.0.0.1",
        port,
        secure: false,
        user: "smtp-user",
        pass: "smtp-pass",
        from: "shop@example.com"
      });
      const result = await sender.send({
        to: "jane@example.com",
        subject: "Your quote is ready",
        body: "Hi Jane, sign here."
      });
      expect(result.providerMessageId).toBe("fake-msg-1");
      expect(received.some(l => l.startsWith("MAIL FROM:<shop@example.com>"))).toBe(true);
      expect(received.some(l => l.startsWith("RCPT TO:<jane@example.com>"))).toBe(true);
      expect(dataPayload).toContain("Subject: Your quote is ready");
      expect(dataPayload).toContain("Hi Jane, sign here.");
    });
  });
});
