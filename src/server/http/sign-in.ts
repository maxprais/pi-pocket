/** The pages outside the app: signing in with a link, joining with an invite, and a share that arrived too early. */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { PocketApp } from "../app.ts";
import { type Auth, quickTunnelHost, setAuthCookie, setPendingCookie } from "../auth.ts";
import type { User } from "../config.ts";
import { HttpError } from "../errors.ts";
import { cleanEmail } from "../two-factor.ts";
import { conversationId, escapeHtml, readBody, send } from "./io.ts";

/** A form posted from another site, as browsers report it. Such a post must not sign this browser in or out. */
function crossSite(request: IncomingMessage): boolean {
    const site = request.headers["sec-fetch-site"];

    return site !== undefined && site !== "same-origin" && site !== "none";
}

/** Where to go after signing in: a path on this server, never `//host` or `/\host`, which browsers read as another site. */
function localPath(next: string | null): string {
    return next !== null && /^\/(?![/\\])/.test(next) ? next : "/";
}

function page(title: string, body: string): string {
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="dark"><title>${escapeHtml(title)}</title><link rel="stylesheet" href="/style.css"></head><body class="plain-page"><main class="plain">${body}</main></body></html>`;
}

/**
 * With email sign-in on: mail a code to the person and send the browser to the page that takes it. The person's email is
 * the owner's from the environment, or the one a guest gave when they joined; never one typed by whoever holds a token.
 */
async function askForCode(
    auth: Auth,
    request: IncomingMessage,
    response: ServerResponse,
    user: User,
    email: string | undefined,
    next: string,
): Promise<void> {
    const twoFactor = auth.twoFactor;

    if (twoFactor === undefined) {
        throw new HttpError(500, "Email sign-in is off.");
    }

    if (email === undefined) {
        return send(
            response,
            403,
            page(
                "Max's Agent",
                "<h1>No email on file</h1><p>This device cannot sign in until the owner removes you and invites you again. You will be asked for your email.</p>",
            ),
            "text/html; charset=utf-8",
        );
    }

    let id: string | undefined;

    try {
        id = await twoFactor.begin(user.id, email, next);
    } catch (error) {
        console.error(`Pi Pocket could not send a sign-in code: ${(error as Error).message}`);

        return send(
            response,
            502,
            page(
                "Max's Agent",
                "<h1>Could not send the code</h1><p>The email did not go. Try again in a minute, or ask the owner to check the server's mail settings.</p>",
            ),
            "text/html; charset=utf-8",
        );
    }

    if (id === undefined) {
        return send(
            response,
            429,
            page("Max's Agent", "<h1>Too many codes</h1><p>Wait an hour, then try again.</p>"),
            "text/html; charset=utf-8",
        );
    }

    setPendingCookie(request, response, id);
    response.writeHead(303, { location: "/login/verify" });
    response.end();
}

function codePage(where: string, notice = "", generic = false): string {
    const says = generic
        ? `If an account uses ${escapeHtml(where)}, a 6-digit code is on its way. It works for 10 minutes.`
        : `A 6-digit code went to ${escapeHtml(where)}. It works for 10 minutes.`;

    return page(
        "Enter your code · Max's Agent",
        `<h1>Check your email</h1><p>${says}</p>${notice}<form method="post" action="/login/verify"><input type="hidden" name="action" value="verify"><label>Code<input name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9 ]*" maxlength="8" autofocus required></label><button type="submit">Sign in</button></form><form method="post" action="/login/verify"><input type="hidden" name="action" value="resend"><button type="submit">Send a new code</button></form>`,
    );
}

/** The most email sign-ins one address of the network may start in ten minutes. */
const MAX_EMAIL_LOGINS = 10;
const emailLogins = new Map<string, number[]>();

/** Who is asking, as the proxy in front saw them: the last address it added, or the socket's own. */
function clientOf(request: IncomingMessage): string {
    const forwarded = String(request.headers["x-forwarded-for"] ?? "")
        .split(",")
        .at(-1)
        ?.trim();

    return forwarded || request.socket.remoteAddress || "unknown";
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * `/login/email`: sign in from the homepage with an email address. If an account uses it, a code goes there; either way
 * the browser lands on the same page, so nobody can find out which addresses have accounts. The answer also takes about
 * as long, because a send does.
 */
export async function emailLogin(
    auth: Auth,
    request: IncomingMessage,
    response: ServerResponse,
): Promise<void> {
    if (request.method !== "POST") {
        response.writeHead(303, { location: "/" });
        response.end();

        return;
    }

    if (crossSite(request)) {
        throw new HttpError(403, "Sign in from Max's Agent's own page.");
    }

    const twoFactor = auth.twoFactor;

    if (twoFactor === undefined) {
        return send(
            response,
            404,
            page(
                "Max's Agent",
                "<h1>Email sign-in is off</h1><p>Use the sign-in link Max's Agent printed, or an invite.</p>",
            ),
            "text/html; charset=utf-8",
        );
    }

    const now = Date.now();
    const who = clientOf(request);
    const recent = (emailLogins.get(who) ?? []).filter((at) => now - at < 10 * 60 * 1000);

    emailLogins.set(who, [...recent, now]);

    if (recent.length >= MAX_EMAIL_LOGINS) {
        return send(
            response,
            429,
            page("Max's Agent", "<h1>Too many tries</h1><p>Wait ten minutes, then try again.</p>"),
            "text/html; charset=utf-8",
        );
    }

    const form = new URLSearchParams((await readBody(request, 10_000)).toString("utf8"));
    const email = cleanEmail(form.get("email") ?? "");

    if (email === undefined) {
        return send(
            response,
            400,
            page("Max's Agent", "<h1>Not an email address</h1><p>Go back and check it.</p>"),
            "text/html; charset=utf-8",
        );
    }

    const user = auth.userByEmail(email);
    let id: string | undefined;

    if (user !== undefined) {
        try {
            id = await twoFactor.begin(user.id, email, "/", true);
        } catch (error) {
            // Said in the log, not on the page: the page must not tell an address with an account from one without.
            console.error(`Pi Pocket could not send a sign-in code: ${(error as Error).message}`);
        }
    } else {
        await sleep(1500);
    }

    setPendingCookie(request, response, id ?? twoFactor.decoy(email));
    response.writeHead(303, { location: "/login/verify" });
    response.end();
}

/** `/login/verify`: the page that takes the emailed code, and signs the browser in when it is right. */
export async function verify(
    auth: Auth,
    request: IncomingMessage,
    response: ServerResponse,
): Promise<void> {
    const twoFactor = auth.twoFactor;
    const id = auth.pending(request);
    const where = twoFactor === undefined || id === undefined ? undefined : twoFactor.where(id);
    const generic = twoFactor !== undefined && id !== undefined && twoFactor.generic(id);

    if (twoFactor === undefined || id === undefined || where === undefined) {
        return send(
            response,
            410,
            page(
                "Max's Agent",
                `<h1>Code expired</h1><p>Open your sign-in link again to get a new code.</p>`,
            ),
            "text/html; charset=utf-8",
        );
    }

    if (request.method !== "POST") {
        return send(response, 200, codePage(where, "", generic), "text/html; charset=utf-8", {
            "referrer-policy": "no-referrer",
        });
    }

    if (crossSite(request)) {
        throw new HttpError(403, "Sign in from Max's Agent's own page.");
    }

    const form = new URLSearchParams((await readBody(request, 10_000)).toString("utf8"));

    if (form.get("action") === "resend") {
        let result: "sent" | "wait" | "gone";

        try {
            result = await twoFactor.resend(id);
        } catch (error) {
            console.error(`Pi Pocket could not send a sign-in code: ${(error as Error).message}`);

            return send(
                response,
                502,
                codePage(where, "<p>The email did not go. Try again in a minute.</p>", generic),
                "text/html; charset=utf-8",
            );
        }

        const notice =
            result === "sent"
                ? "<p>A new code is on its way.</p>"
                : "<p>Wait a minute before asking for another code.</p>";

        return send(
            response,
            result === "gone" ? 410 : 200,
            codePage(where, notice, generic),
            "text/html; charset=utf-8",
        );
    }

    const result = twoFactor.verify(id, form.get("code") ?? "");

    if (!result.ok) {
        const notice =
            result.reason === "wrong"
                ? `<p>That code is not right. ${result.left} ${result.left === 1 ? "try" : "tries"} left.</p>`
                : "";

        if (result.reason !== "wrong") {
            return send(
                response,
                410,
                page(
                    "Max's Agent",
                    "<h1>Code expired</h1><p>Open your sign-in link again to get a new code.</p>",
                ),
                "text/html; charset=utf-8",
            );
        }

        return send(response, 401, codePage(where, notice, generic), "text/html; charset=utf-8");
    }

    auth.startSession(request, response, result.userId);
    response.writeHead(303, { location: localPath(result.next) });
    response.end();
}

/** `/login`: sign this browser in with a token from a link, after asking when it would switch accounts. */
export async function login(
    auth: Auth,
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
): Promise<void> {
    const posted = request.method === "POST";

    if (posted && crossSite(request)) {
        throw new HttpError(403, "Sign in from Max's Agent's own page.");
    }

    const form = posted
        ? new URLSearchParams((await readBody(request, 10_000)).toString("utf8"))
        : url.searchParams;
    const token = form.get("token") ?? "";
    const next = localPath(form.get("next"));
    const signingIn = auth.tokenUser(token);

    if (signingIn === undefined) {
        return send(
            response,
            401,
            page(
                "Max's Agent",
                `<h1>Link expired</h1><p>That login link is not valid. Use the link Max's Agent prints when it starts, or ask someone signed in for a new invite.</p>`,
            ),
            "text/html; charset=utf-8",
        );
    }

    const current = auth.user(request);

    if (!posted && current !== undefined && current.id !== signingIn.id) {
        // Signed in as someone else: switching takes a tap, so a link on another site cannot do it unnoticed.
        return send(
            response,
            200,
            page(
                "Switch account? · Max's Agent",
                `<h1>Switch account?</h1><p>This browser is signed in as ${escapeHtml(current.name)}. The link you opened signs it in as ${escapeHtml(signingIn.name)} instead.</p><form method="post" action="/login"><input type="hidden" name="token" value="${escapeHtml(token)}"><input type="hidden" name="next" value="${escapeHtml(next)}"><button type="submit">Sign in as ${escapeHtml(signingIn.name)}</button></form><p><a href="/">Stay signed in as ${escapeHtml(current.name)}</a></p>`,
            ),
            "text/html; charset=utf-8",
            { "referrer-policy": "no-referrer" },
        );
    }

    if (auth.twoFactor !== undefined) {
        const email = signingIn.role === "owner" ? auth.twoFactor.ownerEmail : signingIn.email;

        return askForCode(auth, request, response, signingIn, email, next);
    }

    setAuthCookie(request, response, token);
    response.writeHead(303, { location: next });
    response.end();

    return;
}

/** `/join/:code`: what an invite grants, and redeeming it with a name (or, for an owner invite, signing in as the owner). */
export async function join(
    app: PocketApp,
    auth: Auth,
    request: IncomingMessage,
    response: ServerResponse,
    code: string,
): Promise<void> {
    if (request.method === "POST") {
        if (crossSite(request)) {
            throw new HttpError(403, "Join from Max's Agent's own page.");
        }

        const form = new URLSearchParams((await readBody(request, 10_000)).toString("utf8"));
        const grant = auth.invite(code);
        const email = cleanEmail(form.get("email") ?? "");

        // A guest's email has to be known before the invite is spent, or a typo would use it up.
        if (auth.twoFactor !== undefined && grant?.role !== "owner" && email === undefined) {
            return send(
                response,
                400,
                page(
                    "Join Max's Agent",
                    "<h1>Email needed</h1><p>Go back and enter an email address. Max's Agent sends a sign-in code there.</p>",
                ),
                "text/html; charset=utf-8",
            );
        }

        if (
            auth.twoFactor !== undefined &&
            email !== undefined &&
            auth.userByEmail(email) !== undefined
        ) {
            return send(
                response,
                400,
                page(
                    "Join Max's Agent",
                    "<h1>Email already in use</h1><p>Go back and use a different email address.</p>",
                ),
                "text/html; charset=utf-8",
            );
        }

        const redeemed = auth.redeem(code, form.get("name") ?? "");

        if (redeemed === undefined) {
            return send(
                response,
                410,
                page("Max's Agent", "<h1>Invite expired</h1><p>Ask for a new one.</p>"),
                "text/html; charset=utf-8",
            );
        }

        const tunnel = quickTunnelHost(request);

        // The owner is never tied to one tunnel.
        if (tunnel !== undefined && redeemed.user.role !== "owner") {
            app.config.updateUser(redeemed.user.id, { tunnel });
        }

        if (auth.twoFactor !== undefined) {
            if (redeemed.user.role !== "owner" && email !== undefined) {
                app.config.updateUser(redeemed.user.id, { email });
            }

            return askForCode(
                auth,
                request,
                response,
                redeemed.user,
                redeemed.user.role === "owner" ? auth.twoFactor.ownerEmail : email,
                "/",
            );
        }

        setAuthCookie(request, response, redeemed.token);
        response.writeHead(303, { location: "/" });
        response.end();

        return;
    }

    const grant = auth.invite(code);

    if (grant === undefined) {
        return send(
            response,
            410,
            page(
                "Max's Agent",
                "<h1>Invite expired</h1><p>Each invite works once, and only until it expires. Ask for a new one.</p>",
            ),
            "text/html; charset=utf-8",
        );
    }

    if (grant.role === "owner") {
        const current = auth.user(request);
        // Signed in as someone else: say so, as switching accounts does.
        const switching =
            current !== undefined && current.role !== "owner"
                ? `<p>This browser is signed in as ${escapeHtml(current.name)}. It will change to the owner.</p>`
                : "";

        return send(
            response,
            200,
            page(
                "Sign in as owner · Max's Agent",
                `<h1>Sign in as owner</h1><p>This device will sign in as you, the owner. It gets full control of Max's Agent and of this machine.</p>${switching}<form method="post"><button type="submit">Sign in as owner</button></form>`,
            ),
            "text/html; charset=utf-8",
            { "referrer-policy": "no-referrer" },
        );
    }

    const where =
        grant.session === undefined
            ? "every session on this server"
            : `the session “${escapeHtml(await app.conversationTitle(conversationId(grant.session)))}”`;
    const emailField =
        auth.twoFactor === undefined
            ? ""
            : `<label>Your email<input name="email" type="email" maxlength="254" required placeholder="you@example.com" autocomplete="email"></label><p class="muted">Max's Agent sends a sign-in code here.</p>`;
    const can =
        grant.role === "viewer"
            ? `read ${where} and chat with the people there, but not steer Pi`
            : `read and steer ${where}. Pi can run commands on this machine`;

    return send(
        response,
        200,
        page(
            "Join Max's Agent",
            `<h1>Join Max's Agent</h1><p>This device will be able to ${can}.</p><form method="post"><label>Your name<input name="name" maxlength="40" autofocus required placeholder="e.g. Alex"></label>${emailField}<button type="submit">Join</button></form>`,
        ),
        "text/html; charset=utf-8",
    );
}

/** `/share`: a share that reached the server, before the service worker that takes shares was installed here. */
export function sharePage(response: ServerResponse): void {
    return send(
        response,
        200,
        page(
            "Share to Pi",
            `<h1>Open Max's Agent first</h1><p>Sharing works once Max's Agent has been opened on this device over https. Open it, then share again.</p><p><a href="/">Open Max's Agent</a></p>`,
        ),
        "text/html; charset=utf-8",
    );
}
