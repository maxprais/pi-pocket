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
