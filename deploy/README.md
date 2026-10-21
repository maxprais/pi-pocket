# Deploying Pi Pocket to DigitalOcean

A log of how this deployment was made, step by step, so it can be repeated. Each step says what it does and why. This file is updated as the deployment goes on.

**Status:** live at `https://agent.maxprais.com` (HTTPS from Let's Encrypt, through Caddy), owner token rotated, email sign-in on (codes sent through Resend from `mail.maxprais.com`).

## Choices made

| Choice       | Value                                             | Why                                                                                  |
| ------------ | ------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Provider     | DigitalOcean                                      | A full VM with root. Pi's agents run shell commands and Chromium, so a VM fits best. |
| Plan         | Basic, Regular SSD, 2 vCPU / 4 GB / 80 GB, $24/mo | Chromium needs memory, and a second vCPU keeps the app responsive during builds.     |
| Backups      | On (+$4.80/mo, $28.80/mo in all)                  | `pocket.sqlite` is the lasting state.                                                |
| Region       | London (LON1)                                     |                                                                                      |
| OS           | Ubuntu 24.04 LTS                                  | Most tested for Pi Pocket on Linux.                                                  |
| Code         | The owner's fork, `github.com/maxprais/pi-pocket` | The email sign-in is built there.                                                    |
| Access mode  | `local`, with Caddy in front                      | The app listens on `127.0.0.1:8787` only. Caddy gives it HTTPS.                      |
| Browser tool | Yes, Google Chrome                                | Ubuntu's `chromium` is a snap, which does not run well as a service.                 |

## Steps taken

### 1. Create the Droplet (dashboard)

Created in the DigitalOcean dashboard with the plan above and the owner's SSH key (public half only). The Droplet kept the default name `agent`; its IPv4 address is `46.101.32.29`.

### 2. SSH key with a passphrase

```bash
ssh-keygen -t ed25519 -C "pi-pocket"
```

```bash
ssh-add --apple-use-keychain ~/.ssh/id_ed25519
```

A passphrase protects the private key if the laptop is lost. The second command keeps it in the macOS Keychain so SSH does not ask each time. The private key never leaves the laptop.

### 3. Base system (as root)

- `apt update` and `apt upgrade` for security updates.
- `adduser --disabled-password pocket`: an unprivileged user that runs Pi Pocket and its agents.
- A 2 GB swap file, kept in `/etc/fstab`, so a Chromium spike does not get a process killed.
- `ufw` host firewall: allow `OpenSSH`, `80/tcp`, and `443/tcp`; deny the rest. SSH is allowed first so the session is not cut off.
- Node.js 22 (NodeSource), `git`, `build-essential`, and `gh`.
- Google Chrome from Google's `.deb`.

Checked: Node v22.23.4 (Pi Pocket needs 22.19 or newer), Chrome 156, swap active, `ufw` active.

### 4. Get the code (as `pocket`)

```bash
su - pocket -c "git clone https://github.com/maxprais/pi-pocket.git && cd pi-pocket && npm ci"
```

The clone lands in `/home/pocket/pi-pocket`, not root's home. `npm ci` installs the versions in `package-lock.json` exactly.

### 5. systemd service

`/etc/systemd/system/pi-pocket.service`:

```ini
[Unit]
Description=Pi Pocket
After=network-online.target
Wants=network-online.target

[Service]
User=pocket
WorkingDirectory=/home/pocket/pi-pocket
Environment=PI_POCKET_ACCESS=local
Environment=PI_POCKET_PORT=8787
Environment=PI_POCKET_DIR=/home/pocket/.pi-pocket
Environment=PI_POCKET_BROWSER=/usr/bin/google-chrome-stable
ExecStart=/usr/bin/node bin/pi-pocket.js --access local --cwd /home/pocket/projects
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

```bash
install -d -o pocket -g pocket /home/pocket/projects
```

```bash
systemctl daemon-reload && systemctl enable --now pi-pocket
```

Checked: `systemctl is-active pi-pocket` says `active`, and `ss -ltnp | grep 8787` shows it listening on `127.0.0.1:8787` only.

### 6. DNS (at GoDaddy)

The domain's DNS is at GoDaddy (name servers `ns09`/`ns10.domaincontrol.com`), so the record was added there by hand: type `A`, name `agent`, value `46.101.32.29`, lowest TTL.

```bash
dig +short agent.maxprais.com A
```

Checked against GoDaddy's name server, `8.8.8.8`, and `1.1.1.1`: all return `46.101.32.29`. A laptop's own resolver can lag behind for a few minutes.

### 7. HTTPS with Caddy

Caddy gets a Let's Encrypt certificate for the name, renews it on its own, and proxies to Pi Pocket. It needs ports 80 and 443 open (both are in `ufw`) and a name that resolves to this server.

```bash
apt-get install -y caddy
```

`/etc/caddy/Caddyfile`:

```
agent.maxprais.com {
    reverse_proxy 127.0.0.1:8787 {
        flush_interval -1
    }
}
```

```bash
caddy validate --config /etc/caddy/Caddyfile && systemctl reload caddy
```

`flush_interval -1` stops Caddy from buffering the live event streams that Pi Pocket uses. Pi Pocket reads `x-forwarded-proto` and `x-forwarded-host`, which Caddy sets, to mark its cookie `Secure` and to build links.

Checked: the log says "certificate obtained successfully". `https://agent.maxprais.com/` answers `HTTP/2 200`, and `http://` answers `308` with a redirect to `https://`. The Ubuntu package is Caddy 2.6.2, which is older than current but works for this.

### 8. Rotate the owner token

The first token was printed in a log that was shared, so it was replaced. The flag works when the server starts, and it would rotate again at every restart if left on, so it is added for one restart and taken out again:

```bash
sed -i 's|--cwd /home/pocket/projects|--cwd /home/pocket/projects --rotate-token|' /etc/systemd/system/pi-pocket.service
```

```bash
systemctl daemon-reload && systemctl restart pi-pocket
```

```bash
sed -i 's| --rotate-token||' /etc/systemd/system/pi-pocket.service && systemctl daemon-reload
```

Checked: a hash of the token in `config.json` changed, the service is `active`, and the unit's `ExecStart` is back to its normal form. The old link no longer works.

The owner reads the new link on their own machine, so it never goes into a chat:

```bash
ssh root@46.101.32.29 'node -p "\"https://agent.maxprais.com/login?token=\"+require(\"/home/pocket/.pi-pocket/config.json\").ownerToken"'
```

Pi Pocket prints the sign-in link in its log at each start, so the current token is also in `journalctl -u pi-pocket` for anyone with root on the server.

### 9. Email sign-in (deployed)

Built in the fork: a sign-in link must be followed by a 6-digit code sent to the person's email. See "Email sign-in" in the main `README.md` for how it behaves. It is off until three variables are set on the server.

Code: `src/server/two-factor.ts` (codes, limits, mailer), `src/server/auth.ts` (sessions, and the login token no longer signs anything in while it is on), `src/server/http/sign-in.ts` (the code page, and the email field when joining), `src/server/config.ts` (stored sessions). Tests: `test/two-factor.test.ts`.

To turn it on, as root on the server (the file is only readable by root and the service):

```bash
install -m 600 -o root -g root /dev/null /etc/pi-pocket.env
```

Put the three variables in `/etc/pi-pocket.env`, then add `EnvironmentFile=/etc/pi-pocket.env` under `[Service]` in the unit, run `systemctl daemon-reload`, and pull the new code and restart:

```bash
su - pocket -c "cd pi-pocket && git pull && npm ci" && systemctl restart pi-pocket
```

### 10. Mail through Resend, and the deploy

- Resend sends from the subdomain `mail.maxprais.com`, not the root domain, which already has Microsoft 365 mail and its own SPF record. Resend's DKIM, SPF, and return-path records were added at GoDaddy and checked with `dig` against `8.8.8.8`.
- DigitalOcean blocks outbound SMTP on ports 25, 465, and 587 (checked from the server with `bash -c "</dev/tcp/smtp.resend.com/PORT"`: only 2465 and 2587 were open), so the address uses Resend's port `2465`: `smtps://resend:KEY@smtp.resend.com:2465`. With 465 the sign-in page loaded forever.
- The SMTP settings are in `/etc/pi-pocket.env` (mode 600, owned by root), which the unit loads with `EnvironmentFile=`. The API key was typed on the server by the owner, so it never appeared in a chat or in the repo.
- Sign-in was checked end to end: the link led to the code page, the code arrived at the owner's address, and entering it signed the owner in. The owner token was rotated again afterwards, because the link had been pasted into a chat; the old link answers `401`.
- Pushed to the fork's `main` (`3b7babc`, then `12dc7ea` for the mail timeouts), then on the server: `git pull --ff-only`, `npm ci`, `systemctl restart pi-pocket`.

Checked: the service is `active` with no start error, and the login token sent as a `Bearer` header now answers `401`, so email sign-in is on.

### 11. Sign in from the homepage with an email

Pushed as `aab99f6` and deployed (`git pull --ff-only`, `systemctl restart pi-pocket`). The homepage takes an email address as well as a link, token, or invite code: an account that uses it gets a code, and the code signs in with no link. The owner's address is `PI_POCKET_OWNER_EMAIL`; a guest's is the one they gave when they joined. An address with no account gets the same page and a similar delay, so the page never says which addresses have accounts. Checked on the server: `/login/email` answers, a bad address gets `400`, and `signin.js` carries the form. Because the owner can now sign in with only an email code, the owner's email account is the key: turn on 2-step verification for it.

### 12. Hardening: SSH check, Cloud Firewall, reboot

- **SSH settings** (checked with `sshd -T`, nothing changed): password and keyboard-interactive login are off, so root needs a key; root login is `yes`, which with passwords off means key only; one authorized key (`pi-pocket`); the only other login user is `pocket`, and the `sudo` group is empty, so Pi and its agents cannot use `sudo`; `unattended-upgrades` is on; `fail2ban` is not installed (optional, it would only cut log noise with key-only SSH).
- **DigitalOcean Cloud Firewall** `pi-pocket-web`, applied to the `agent` Droplet: inbound SSH 22, HTTP 80, and HTTPS 443 from anywhere; outbound as DigitalOcean's defaults (ICMP, all TCP, all UDP). It sits in front of `ufw` as a second layer. Checked from outside: SSH works, HTTPS answers `200`, HTTP answers `308`, and ports 8787, 3000, 25, and 5432 are closed.
- **Reboot:** `/var/run/reboot-required` did not exist, so no update needed it, but one was done to prove that Pi Pocket and Caddy start on their own.

### 13. Renamed to Max's Agent

Pushed as `6651c0d` and deployed (`git pull --ff-only`, `systemctl restart pi-pocket`). The browser app, the sign-in and join pages, and the sign-in code email say "Max's Agent". The sender's display name is in `/etc/pi-pocket.env` (`PI_POCKET_MAIL_FROM="Max's Agent <pocket@mail.maxprais.com>"`); only that line changed, and the address is the same, so the Resend domain needs nothing. Unchanged on purpose: code comments, server log lines, the `PI_POCKET_*` settings, the service and folder names, and the extension gallery's version messages. A phone's home-screen icon keeps the old name until the app is removed and added again.

## Still to do

1. Try a guest invite end to end, to check a guest's code goes to the email they typed.
2. Turn on 2-step verification for the owner's email account: the owner can sign in with only an email code.
3. Optional: Lancet Guard (Menu → Extensions), so risky commands wait for approval.
4. Optional: let the owner type the guest's email when making an invite, so an intercepted invite link cannot be used by someone else.

## Operating it

| Task            | Command                                                    |
| --------------- | ---------------------------------------------------------- |
| Status          | `systemctl status pi-pocket`                               |
| Logs            | `journalctl -u pi-pocket -f`                               |
| Restart         | `systemctl restart pi-pocket`                              |
| Update the code | As `pocket`: `cd pi-pocket && git pull && npm ci`; restart |
| Firewall rules  | `ufw status verbose`                                       |
| What is stored  | `/home/pocket/.pi-pocket` (`pocket.sqlite`, `config.json`) |

Keep the owner sign-in link private. It is the owner's key, and anyone who has it can make Pi run commands on this server.
