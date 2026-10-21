/**
 * Email sign-in: a device that has a valid login token or invite must also type a code sent to the person's email
 * before it gets a session. It is on only when `PI_POCKET_SMTP_URL`, `PI_POCKET_MAIL_FROM`, and `PI_POCKET_OWNER_EMAIL`
 * are all set; with none of them set Pi Pocket signs in as it always did.
 */
import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";

/** How long a code works. */
export const CODE_MS = 10 * 60 * 1000;
/** How many wrong codes one challenge takes before it ends. */
export const MAX_ATTEMPTS = 5;
/** The least time between two codes sent for one challenge. */
export const RESEND_MS = 60 * 1000;
/** The most codes sent to one address in an hour. */
export const MAX_SENDS_PER_HOUR = 5;
/** The most unfinished challenges kept at once; the oldest end first. */
const MAX_CHALLENGES = 200;

export interface Mailer {
    send(to: string, subject: string, text: string): Promise<void>;
}

export interface TwoFactorSettings {
    smtpUrl: string;
    from: string;
    ownerEmail: string;
}

interface Challenge {
    userId: string;
    email: string;
    codeHash: string;
    expiresAt: number;
    attempts: number;
    sentAt: number;
    /** Where to go after signing in: a path on this server. */
    next: string;
}

export type Verified =
    | { ok: true; userId: string; next: string }
    | { ok: false; reason: "expired" | "wrong" | "locked"; left: number };

function hash(text: string): string {
    return createHash("sha256").update(text).digest("hex");
}

function same(a: string, b: string): boolean {
    const left = Buffer.from(a, "hex");
    const right = Buffer.from(b, "hex");

    return left.length === right.length && timingSafeEqual(left, right);
}

/** An address as people write it, or undefined: one `@`, no spaces, no line breaks, no more than 254 characters. */
export function cleanEmail(text: string): string | undefined {
    const email = text.trim().toLowerCase();

    return email.length <= 254 && /^[^\s@<>,;"']+@[^\s@<>,;"']+\.[^\s@<>,;"']+$/.test(email)
        ? email
        : undefined;
}

/** `a***@example.com`, for a page that says where a code went without giving the address away. */
export function maskEmail(email: string): string {
    const at = email.lastIndexOf("@");

    return `${email.slice(0, 1)}***${email.slice(at)}`;
}

/** What is set in the environment, or undefined when email sign-in is off. A partial setting is an error, not "off". */
export function settingsFrom(env: NodeJS.ProcessEnv): TwoFactorSettings | undefined {
    const smtpUrl = env.PI_POCKET_SMTP_URL?.trim();
    const from = env.PI_POCKET_MAIL_FROM?.trim();
    const owner = env.PI_POCKET_OWNER_EMAIL?.trim();

    if (!smtpUrl && !from && !owner) {
        return undefined;
    }

    if (!smtpUrl || !from || !owner) {
        throw new Error(
            "Email sign-in needs PI_POCKET_SMTP_URL, PI_POCKET_MAIL_FROM, and PI_POCKET_OWNER_EMAIL together.",
        );
    }

    const ownerEmail = cleanEmail(owner);

    if (ownerEmail === undefined) {
        throw new Error("PI_POCKET_OWNER_EMAIL is not an email address.");
    }

    return { smtpUrl, from, ownerEmail };
}

/** A mailer that sends over SMTP. `nodemailer` loads when the first code goes, so it costs nothing while this is off. */
export function smtpMailer(settings: TwoFactorSettings): Mailer {
    let transport: Promise<import("nodemailer").Transporter> | undefined;

    return {
        async send(to, subject, text) {
            transport ??= import("nodemailer").then((mod) => mod.createTransport(settings.smtpUrl));
            await (await transport).sendMail({ from: settings.from, to, subject, text });
        },
    };
}

export class TwoFactor {
    readonly ownerEmail: string;
    readonly #mailer: Mailer;
    readonly #challenges = new Map<string, Challenge>();
    readonly #sends = new Map<string, number[]>();
    readonly #now: () => number;

    constructor(settings: Pick<TwoFactorSettings, "ownerEmail">, mailer: Mailer, now = Date.now) {
        this.ownerEmail = settings.ownerEmail;
        this.#mailer = mailer;
        this.#now = now;
    }

    /** Start a sign-in for `userId`: mail a code to `email` and return the challenge's id, for the browser's cookie. */
    async begin(userId: string, email: string, next: string): Promise<string | undefined> {
        if (!this.#roomToSend(email)) {
            return undefined;
        }

        const id = randomBytes(24).toString("base64url");

        this.#prune();

        if (this.#challenges.size >= MAX_CHALLENGES) {
            const oldest = this.#challenges.keys().next().value;

            if (oldest !== undefined) {
                this.#challenges.delete(oldest);
            }
        }

        const challenge: Challenge = {
            userId,
            email,
            codeHash: "",
            expiresAt: this.#now() + CODE_MS,
            attempts: 0,
            sentAt: 0,
            next,
        };

        this.#challenges.set(id, challenge);

        try {
            await this.#mail(id, challenge);
        } catch (error) {
            this.#challenges.delete(id);

            throw error;
        }

        return id;
    }

    /** Send a new code for a challenge, if it is live and the last one went at least `RESEND_MS` ago. */
    async resend(id: string): Promise<"sent" | "wait" | "gone"> {
        const challenge = this.#live(id);

        if (challenge === undefined) {
            return "gone";
        }

        if (this.#now() - challenge.sentAt < RESEND_MS || !this.#roomToSend(challenge.email)) {
            return "wait";
        }

        challenge.attempts = 0;
        await this.#mail(id, challenge);

        return "sent";
    }

    /** Check a typed code. A right one ends the challenge; too many wrong ones end it too. */
    verify(id: string, typed: string): Verified {
        const challenge = this.#live(id);

        if (challenge === undefined) {
            return { ok: false, reason: "expired", left: 0 };
        }

        const code = typed.replace(/\s+/g, "");

        if (challenge.attempts >= MAX_ATTEMPTS) {
            this.#challenges.delete(id);

            return { ok: false, reason: "locked", left: 0 };
        }

        // The code is hashed with the challenge's id, so a hash from one challenge says nothing about another's.
        if (/^\d{6}$/.test(code) && same(challenge.codeHash, hash(`${id}:${code}`))) {
            this.#challenges.delete(id);

            return { ok: true, userId: challenge.userId, next: challenge.next };
        }

        challenge.attempts += 1;

        if (challenge.attempts >= MAX_ATTEMPTS) {
            this.#challenges.delete(id);

            return { ok: false, reason: "locked", left: 0 };
        }

        return { ok: false, reason: "wrong", left: MAX_ATTEMPTS - challenge.attempts };
    }

    /** Where a live challenge's code went, masked; undefined when it ended. */
    where(id: string): string | undefined {
        const challenge = this.#live(id);

        return challenge === undefined ? undefined : maskEmail(challenge.email);
    }

    #live(id: string): Challenge | undefined {
        const challenge = this.#challenges.get(id);

        if (challenge === undefined) {
            return undefined;
        }

        if (challenge.expiresAt < this.#now()) {
            this.#challenges.delete(id);

            return undefined;
        }

        return challenge;
    }

    #prune(): void {
        const now = this.#now();

        for (const [id, challenge] of this.#challenges) {
            if (challenge.expiresAt < now) {
                this.#challenges.delete(id);
            }
        }
    }

    #roomToSend(email: string): boolean {
        const now = this.#now();
        const recent = (this.#sends.get(email) ?? []).filter((at) => now - at < 60 * 60 * 1000);

        this.#sends.set(email, recent);

        return recent.length < MAX_SENDS_PER_HOUR;
    }

    async #mail(id: string, challenge: Challenge): Promise<void> {
        const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
        const now = this.#now();

        await this.#mailer.send(
            challenge.email,
            "Your Pi Pocket sign-in code",
            `Your Pi Pocket sign-in code is ${code}.\n\nIt works for 10 minutes. If you did not try to sign in, ignore this email: nobody can sign in without it.\n`,
        );

        // Only after the mail went: a send that failed uses up no attempt, and no code that never arrived can be typed.
        challenge.codeHash = hash(`${id}:${code}`);
        challenge.expiresAt = now + CODE_MS;
        challenge.sentAt = now;
        this.#sends.set(challenge.email, [...(this.#sends.get(challenge.email) ?? []), now]);
    }
}
