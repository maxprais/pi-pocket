// Email sign-in: a code sent to the person's email, and a session only after it is typed.
import { type App, cleanUp, openApp, owner as ownerOf, scriptedModel } from "./helpers.ts";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, before, test } from "node:test";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai/providers/faux";
import { createHandler } from "../src/server/http.ts";
import {
    CODE_MS,
    cleanEmail,
    MAX_ATTEMPTS,
    MAX_SENDS_PER_HOUR,
    maskEmail,
    RESEND_MS,
    settingsFrom,
    TwoFactor,
} from "../src/server/two-factor.ts";

const faux = scriptedModel(() => fauxAssistantMessage([fauxText("ok")]));

let app: App;
let clock = 1_000_000;
let inbox: { to: string; text: string }[] = [];
let failMail = false;

const twoFactor = new TwoFactor(
    { ownerEmail: "owner@example.com" },
    {
        async send(to, _subject, text) {
            if (failMail) {
                throw new Error("smtp down");
            }

            inbox.push({ to, text });
        },
    },
    () => clock,
);

const lastCode = () => /is (\d{6})\./.exec(inbox.at(-1)?.text ?? "")?.[1] ?? "";

let base = "";

let stop = () => {};

before(async () => {
    app = await openApp(faux);
    const server = createServer(
        createHandler({
            app,
            listen: { host: "127.0.0.1", port: 0 },
            restart: () => {},
            twoFactor,
        }),
    );

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

    stop = () => {
        server.closeAllConnections();
        server.close();
    };
});

after(async () => {
    stop();
    await app?.close();
    cleanUp();
});

/** The cookies a response set, as a header to send back. */
function cookiesOf(response: Response, into: Map<string, string> = new Map()): Map<string, string> {
    for (const line of response.headers.getSetCookie()) {
        const [pair = ""] = line.split(";");
        const index = pair.indexOf("=");
        const name = pair.slice(0, index);
        const value = pair.slice(index + 1);

        if (value === "" || /Max-Age=0/.test(line)) {
            into.delete(name);
        } else {
            into.set(name, value);
        }
    }

    return into;
}

const header = (jar: Map<string, string>) =>
    [...jar].map(([name, value]) => `${name}=${value}`).join("; ");

test("settings: none means off, some is an error, all means on", () => {
    assert.equal(settingsFrom({}), undefined);
    assert.throws(() => settingsFrom({ PI_POCKET_SMTP_URL: "smtp://x" }), /together/);
    assert.throws(
        () =>
            settingsFrom({
                PI_POCKET_SMTP_URL: "smtp://x",
                PI_POCKET_MAIL_FROM: "a@b.co",
                PI_POCKET_OWNER_EMAIL: "not an email",
            }),
        /not an email address/,
    );
    assert.deepEqual(
        settingsFrom({
            PI_POCKET_SMTP_URL: "smtp://x",
            PI_POCKET_MAIL_FROM: "Pi <a@b.co>",
            PI_POCKET_OWNER_EMAIL: "Me@Example.com",
        }),
        { smtpUrl: "smtp://x", from: "Pi <a@b.co>", ownerEmail: "me@example.com" },
    );
});

test("addresses are checked and masked", () => {
    assert.equal(cleanEmail(" A@B.co "), "a@b.co");
    assert.equal(cleanEmail("a@b"), undefined);
    assert.equal(cleanEmail("a b@c.de"), undefined);
    assert.equal(cleanEmail("a@b.co\r\nBcc: x@y.zz"), undefined);
    assert.equal(maskEmail("alex@example.com"), "a***@example.com");
});

test("a right code signs in once, and a wrong one counts down then locks", async () => {
    inbox = [];
    const id = (await twoFactor.begin("u1", "a@example.com", "/x"))!;

    assert.equal(inbox.length, 1);
    assert.equal(twoFactor.where(id), "a***@example.com");

    const code = lastCode();
    const wrong = code === "000000" ? "111111" : "000000";
    const first = twoFactor.verify(id, wrong);

    assert.deepEqual(first, { ok: false, reason: "wrong", left: MAX_ATTEMPTS - 1 });
    assert.deepEqual(twoFactor.verify(id, ` ${code.slice(0, 3)} ${code.slice(3)} `), {
        ok: true,
        userId: "u1",
        next: "/x",
    });
    assert.deepEqual(twoFactor.verify(id, code), { ok: false, reason: "expired", left: 0 });

    const other = (await twoFactor.begin("u1", "a@example.com", "/"))!;
    const real = lastCode();
    const bad = real === "123456" ? "654321" : "123456";

    for (let i = 1; i < MAX_ATTEMPTS; i += 1) {
        assert.equal(twoFactor.verify(other, bad).ok, false);
    }

    assert.deepEqual(twoFactor.verify(other, bad), { ok: false, reason: "locked", left: 0 });
    assert.deepEqual(twoFactor.verify(other, real), { ok: false, reason: "expired", left: 0 });
});

test("a code ends after its time, and a new one waits a minute", async () => {
    inbox = [];
    const id = (await twoFactor.begin("u2", "b@example.com", "/"))!;

    assert.equal(await twoFactor.resend(id), "wait");
    clock += RESEND_MS;
    assert.equal(await twoFactor.resend(id), "sent");
    assert.equal(inbox.length, 2);

    const code = lastCode();

    clock += CODE_MS + 1;
    assert.deepEqual(twoFactor.verify(id, code), { ok: false, reason: "expired", left: 0 });
});

test("an address gets only a few codes an hour, and a send that fails leaves nothing to type", async () => {
    inbox = [];
    clock += 2 * 60 * 60 * 1000;

    for (let i = 0; i < MAX_SENDS_PER_HOUR; i += 1) {
        assert.ok(await twoFactor.begin("u3", "c@example.com", "/"));
    }

    assert.equal(await twoFactor.begin("u3", "c@example.com", "/"), undefined);
    failMail = true;
    await assert.rejects(twoFactor.begin("u3", "d@example.com", "/"), /smtp down/);
    failMail = false;
    clock += 2 * 60 * 60 * 1000;
});

test("the login token alone gets no session, and a session is made only by the code", async () => {
    inbox = [];
    const owner = ownerOf(app);
    const token = app.config.ownerToken;

    // The token as a header or a cookie is no sign-in while email sign-in is on.
    assert.equal(
        (await fetch(`${base}/api/me`, { headers: { authorization: `Bearer ${token}` } })).status,
        401,
    );
    assert.equal(
        (await fetch(`${base}/api/me`, { headers: { cookie: `pocket_auth=${token}` } })).status,
        401,
    );

    const jar = new Map<string, string>();
    const login = await fetch(`${base}/login?token=${encodeURIComponent(token)}`, {
        redirect: "manual",
    });

    assert.equal(login.status, 303);
    assert.equal(login.headers.get("location"), "/login/verify");
    cookiesOf(login, jar);
    assert.ok(jar.has("pocket_2fa"));
    assert.equal(jar.has("pocket_auth"), false, "no session before the code");
    assert.equal(inbox.at(-1)?.to, "owner@example.com");

    const wrong = await fetch(`${base}/login/verify`, {
        method: "POST",
        redirect: "manual",
        headers: { cookie: header(jar), "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ action: "verify", code: "abcdef" }),
    });

    assert.equal(wrong.status, 401);
    assert.equal(cookiesOf(wrong, new Map(jar)).has("pocket_auth"), false);

    const right = await fetch(`${base}/login/verify`, {
        method: "POST",
        redirect: "manual",
        headers: { cookie: header(jar), "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ action: "verify", code: lastCode() }),
    });

    assert.equal(right.status, 303);
    cookiesOf(right, jar);
    assert.ok(jar.has("pocket_auth"));
    assert.notEqual(jar.get("pocket_auth"), token, "the cookie is a session, not the login token");
    assert.equal(jar.has("pocket_2fa"), false);

    const me = await fetch(`${base}/api/me`, { headers: { cookie: header(jar) } });

    assert.equal(me.status, 200);
    assert.equal(((await me.json()) as { id?: string }).id ?? owner.id, owner.id);

    // Signing out ends the session itself, so a copy of its cookie stops working.
    const out = await fetch(`${base}/api/logout`, {
        method: "POST",
        headers: { cookie: header(jar), "x-pocket": "1" },
    });

    assert.equal(out.status, 200);
    assert.equal((await fetch(`${base}/api/me`, { headers: { cookie: header(jar) } })).status, 401);
});

test("rotating the owner token ends the owner's sessions", async () => {
    inbox = [];
    const token = app.config.addSession(ownerOf(app).id);

    assert.ok(app.config.userBySession(token));
    app.config.rotateOwnerToken();
    assert.equal(app.config.userBySession(token), undefined);
});

test("a guest joins with an email, and the code goes there, not to the owner", async () => {
    inbox = [];
    const { Auth } = await import("../src/server/auth.ts");
    const code = new Auth(app.config).createInvite(ownerOf(app)).code;
    const page = await (await fetch(`${base}/join/${code}`)).text();

    assert.match(page, /name="email"/);

    const noEmail = await fetch(`${base}/join/${code}`, {
        method: "POST",
        redirect: "manual",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ name: "Alex" }),
    });

    assert.equal(noEmail.status, 400);

    const joined = await fetch(`${base}/join/${code}`, {
        method: "POST",
        redirect: "manual",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ name: "Alex", email: "Alex@Example.com" }),
    });

    assert.equal(joined.status, 303);
    assert.equal(joined.headers.get("location"), "/login/verify");
    assert.equal(inbox.at(-1)?.to, "alex@example.com");
    assert.equal(cookiesOf(joined).has("pocket_auth"), false);
});

const form = { "content-type": "application/x-www-form-urlencoded" };

/** An email typed on the homepage, from a client of its own. */
const typeEmail = (email: string, client: string) =>
    fetch(`${base}/login/email`, {
        method: "POST",
        redirect: "manual",
        headers: { ...form, "x-forwarded-for": client },
        body: new URLSearchParams({ email }),
    });

const codeFor = async (jar: Map<string, string>, code: string) =>
    fetch(`${base}/login/verify`, {
        method: "POST",
        redirect: "manual",
        headers: { ...form, cookie: header(jar) },
        body: new URLSearchParams({ action: "verify", code }),
    });

test("an email typed on the homepage mails a code, and the code signs the owner in", async () => {
    inbox = [];
    const response = await typeEmail("Owner@Example.com", "10.0.0.1");

    assert.equal(response.status, 303);
    assert.equal(response.headers.get("location"), "/login/verify");
    assert.equal(inbox.length, 1);
    assert.equal(inbox[0]?.to, "owner@example.com");

    const jar = cookiesOf(response);
    const page = await (
        await fetch(`${base}/login/verify`, { headers: { cookie: header(jar) } })
    ).text();

    assert.match(page, /If an account uses o\*\*\*@example\.com/);

    const signedIn = await codeFor(jar, lastCode());

    assert.equal(signedIn.status, 303);
    cookiesOf(signedIn, jar);
    assert.equal((await fetch(`${base}/api/me`, { headers: { cookie: header(jar) } })).status, 200);
});

test("an address with no account looks the same, sends nothing, and no code works", async () => {
    inbox = [];
    const started = Date.now();
    const response = await typeEmail("nobody@example.com", "10.0.0.2");

    assert.ok(Date.now() - started >= 1400, "it takes about as long as a send does");
    assert.equal(response.status, 303);
    assert.equal(response.headers.get("location"), "/login/verify");
    assert.equal(inbox.length, 0, "no mail goes to an address with no account");

    const jar = cookiesOf(response);
    const page = await (
        await fetch(`${base}/login/verify`, { headers: { cookie: header(jar) } })
    ).text();

    assert.match(page, /If an account uses n\*\*\*@example\.com/);

    for (const code of ["000000", "123456", lastCode() || "654321"]) {
        const wrong = await codeFor(jar, code);

        assert.equal(wrong.status, 401);
        assert.equal(cookiesOf(wrong, new Map(jar)).has("pocket_auth"), false);
    }

    const resend = await fetch(`${base}/login/verify`, {
        method: "POST",
        headers: { ...form, cookie: header(jar) },
        body: new URLSearchParams({ action: "resend" }),
    });

    assert.equal(resend.status, 200);
    assert.equal(inbox.length, 0);
});

test("a guest signs in with the email they joined with, and the code goes there", async () => {
    inbox = [];
    const response = await typeEmail("alex@example.com", "10.0.0.3");

    assert.equal(response.headers.get("location"), "/login/verify");
    assert.equal(inbox.at(-1)?.to, "alex@example.com");

    const jar = cookiesOf(response);
    const signedIn = await codeFor(jar, lastCode());

    cookiesOf(signedIn, jar);

    const me = await fetch(`${base}/api/me`, { headers: { cookie: header(jar) } });

    assert.equal(me.status, 200);
    assert.notEqual(((await me.json()) as { role?: string }).role, "owner");
});

test("an invite cannot take an address that already has an account", async () => {
    const { Auth } = await import("../src/server/auth.ts");
    const code = new Auth(app.config).createInvite(ownerOf(app)).code;

    for (const taken of ["owner@example.com", "alex@example.com"]) {
        const response = await fetch(`${base}/join/${code}`, {
            method: "POST",
            redirect: "manual",
            headers: form,
            body: new URLSearchParams({ name: "Sam", email: taken }),
        });

        assert.equal(response.status, 400);
    }

    assert.ok(app.config.invite(code), "the invite is still there to use");
});

test("a bad address is refused, and one client gets only a few tries", async () => {
    assert.equal((await typeEmail("not an email", "10.0.0.4")).status, 400);

    const statuses: number[] = [];

    for (let i = 0; i < 12; i += 1) {
        statuses.push((await typeEmail("owner@example.com", "10.0.0.5")).status);
    }

    assert.equal(
        statuses.slice(0, 10).every((status) => status === 303),
        true,
    );
    assert.deepEqual(statuses.slice(10), [429, 429]);
});

test("a service guest's token works as a bearer with email sign-in on, and no one else's does", async () => {
    const me = (headers: Record<string, string>) => fetch(`${base}/api/me`, { headers });
    const service = app.config.addUser("Canfield", "guest");
    const plain = app.config.addUser("Plain", "guest");
    const viewer = app.config.addUser("Viewer", "viewer");

    // Set by hand, as in config.json: no method sets it.
    service.user.service = true;
    viewer.user.service = true;

    assert.equal((await me({ authorization: `Bearer ${service.token}` })).status, 200);
    assert.equal((await me({ authorization: `Bearer ${plain.token}` })).status, 401);
    assert.equal((await me({ authorization: `Bearer ${viewer.token}` })).status, 401);
    assert.equal((await me({ authorization: "Bearer nope" })).status, 401);
    assert.equal((await me({ cookie: `pocket_auth=${service.token}` })).status, 401);

    ownerOf(app).service = true;
    assert.equal((await me({ authorization: `Bearer ${app.config.ownerToken}` })).status, 401);
    delete ownerOf(app).service;

    app.config.removeUser(service.user.id);
    assert.equal((await me({ authorization: `Bearer ${service.token}` })).status, 401);
});

test("only the owner makes a service guest, and its token then works as a bearer", async () => {
    const post = (headers: Record<string, string>, body: unknown) =>
        fetch(`${base}/api/service-guest`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-pocket": "1", ...headers },
            body: JSON.stringify(body),
        });
    const guest = app.config.addUser("Plain guest", "guest");
    const session = `pocket_auth=${app.config.addSession(ownerOf(app).id)}`;

    assert.equal((await post({}, { name: "Canfield" })).status, 401);
    assert.equal(
        (await post({ authorization: `Bearer ${guest.token}` }, { name: "X" })).status,
        401,
    );
    assert.equal((await post({ cookie: session }, { name: " " })).status, 400);

    const made = await post({ cookie: session }, { name: "Canfield" });

    assert.equal(made.status, 200);

    const { token } = (await made.json()) as { token: string };
    const me = await fetch(`${base}/api/me`, { headers: { authorization: `Bearer ${token}` } });

    assert.equal(me.status, 200);
    assert.equal(app.config.userByToken(token)?.role, "guest");
});

test("a service guest cannot sign in as a person, and a new token ends the old one", async () => {
    const owner = `pocket_auth=${app.config.addSession(ownerOf(app).id)}`;
    const plain = app.config.addUser("Plain", "guest");
    const call = (path: string, headers: Record<string, string>) =>
        fetch(`${base}/api/${path}`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-pocket": "1", ...headers },
            body: "{}",
        });
    const made = app.config.addServiceGuest("Canfield");

    // Its token is no login link, and no cookie.
    const login = await fetch(`${base}/login?token=${made.token}`, { redirect: "manual" });

    assert.equal(login.status, 401);
    assert.equal(
        (await fetch(`${base}/api/me`, { headers: { cookie: `pocket_auth=${made.token}` } }))
            .status,
        401,
    );

    // The people list says which ones are service guests.
    const people = (await (
        await fetch(`${base}/api/users`, { headers: { cookie: owner } })
    ).json()) as { id: string; service?: boolean }[];

    assert.equal(people.find((each) => each.id === made.user.id)?.service, true);

    // Only the owner renews one, and only a service guest's token.
    assert.equal((await call(`service-guest/${made.user.id}/token`, {})).status, 401);
    assert.equal(
        (await call(`service-guest/${plain.user.id}/token`, { cookie: owner })).status,
        404,
    );

    const renewed = await call(`service-guest/${made.user.id}/token`, { cookie: owner });

    assert.equal(renewed.status, 200);

    const { token } = (await renewed.json()) as { token: string };
    const me = (bearer: string) =>
        fetch(`${base}/api/me`, { headers: { authorization: `Bearer ${bearer}` } });

    assert.equal((await me(made.token)).status, 401);
    assert.equal((await me(token)).status, 200);
});
