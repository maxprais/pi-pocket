// The sign-in screen, for a browser that is not signed in.

import { useState } from "preact/hooks";
import { html } from "./ui.js";

export function SignIn() {
    const [value, setValue] = useState("");

    const go = () => {
        const text = value.trim();

        if (!text) {
            return;
        }

        // An email address: the server mails a code if an account uses it, and the next page takes the code.
        if (/^[^\s@/]+@[^\s@/]+\.[^\s@/]+$/.test(text)) {
            const form = document.createElement("form");
            const field = document.createElement("input");

            form.method = "post";
            form.action = "/login/email";
            field.type = "hidden";
            field.name = "email";
            field.value = text;
            form.append(field);
            document.body.append(form);
            form.submit();

            return;
        }

        try {
            const url = new URL(text, location.origin);

            if (url.pathname.startsWith("/join/") || url.searchParams.has("token")) {
                location.href = `${url.pathname}${url.search}`;

                return;
            }
        } catch {
            // not a URL
        }

        // Invite codes are ten lowercase letters and digits, and phones capitalize the first letter typed. Tokens are longer.
        // The invite sheet shows a code in two groups, so spaces typed or copied between them are dropped.
        const code = text.toLowerCase().replace(/\s+/g, "");

        location.href = /^[a-z0-9]{10}$/.test(code)
            ? `/join/${code}`
            : `/login?token=${encodeURIComponent(text)}`;
    };

    return html`<div class="signin" data-part="sign-in">
        <div class="pi big">π</div>
        <h1>Max's Agent</h1>
        <div class="row">
            <input
                value=${value}
                placeholder="Email, link, token, or invite code"
                autocapitalize="none"
                autocorrect="off"
                autocomplete="email"
                spellcheck=${false}
                onInput=${(event) => setValue(event.currentTarget.value)}
                onKeyDown=${(event) => event.key === "Enter" && go()}
            />
            <button class="button primary" onClick=${go}>Sign in</button>
        </div>
    </div>`;
}
