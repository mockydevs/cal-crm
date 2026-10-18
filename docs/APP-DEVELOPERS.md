# Building an app for the App Marketplace

An agency lists its apps in the App Marketplace, and each of its businesses can install
them. An app runs on your own server. It gets into a business through the CRM's public
API, with an access token that business gave it. It connects with OAuth 2.0: the
authorization code flow with PKCE, as in
[RFC 6749](https://www.rfc-editor.org/rfc/rfc6749) and
[RFC 7636](https://www.rfc-editor.org/rfc/rfc7636).

The examples use `https://crm.example.com` for the CRM's address. Use the address of
the install you are building for.

## 1. Set the app up

In the CRM, at agency level, open **Settings → Marketplace apps** and add the app:

- **Permissions it asks for:** what the app may change. A business can grant only these.
- **What it may read:** the groups of the API reference the app may read, such as
  *Contacts* or *Tags*. Reading anything else is refused. An app that asks for nothing to
  read can read nothing.
- **Redirect addresses:** where the CRM sends people back after they decide, one a line,
  up to 10. Use `https://`. `http://localhost` and `http://127.0.0.1` on any port are
  accepted while you test on your own computer. A request must name one of them exactly,
  query string included.

Then open **Connection** on the app's row:

- **Client ID** is the app's id, such as `mapp_01k8…`.
- **Generate client secret** shows the secret once. Keep it on your server only. Replacing
  it stops the old one at once. Businesses that already connected stay connected.

List the app so the agency's businesses can see it.

The CRM describes its OAuth endpoints at
`https://crm.example.com/.well-known/oauth-authorization-server`
([RFC 8414](https://www.rfc-editor.org/rfc/rfc8414)).

## 2. Send the person to the CRM

Make a PKCE pair: a random `code_verifier` of 43 to 128 characters, and its
`code_challenge`, the base64url SHA-256 of the verifier without padding. Keep the
verifier, and a random `state`, with the person's session. Then send them to:

```text
https://crm.example.com/oauth/authorize
  ?response_type=code
  &client_id=mapp_01k8…
  &redirect_uri=https%3A%2F%2Fyourapp.example%2Foauth%2Fcallback
  &state=…
  &code_challenge=…
  &code_challenge_method=S256
```

`scope` is optional. If you send it, list permission keys separated by spaces. They must be
among the ones the app asks for. PKCE is required, and only `S256` is accepted.

The person signs in if they need to, chooses the business, and sees what the app may change
and read there. To allow it, they need the right to manage apps in that business and every
permission the app asks for. **Allow & Install** installs the app if it isn't installed,
and sends the person back to you with:

```text
https://yourapp.example/oauth/callback?code=crm_ac_…&state=…&iss=https%3A%2F%2Fcrm.example.com
```

Check that `state` is yours and that `iss` is the CRM you sent the person to
([RFC 9207](https://www.rfc-editor.org/rfc/rfc9207)). If the person cancels, or something is
wrong with the request, you get `error` instead, such as `access_denied`,
`invalid_request` or `invalid_scope`, with `error_description`. If the client ID or the
redirect address isn't one the CRM knows, the CRM says so on its own page and never sends
the person to that address.

## 3. Trade the code for tokens

A code works once and expires after 10 minutes. Trade it from your server:

```sh
curl https://crm.example.com/oauth/token \
  -u 'mapp_01k8…:crm_cs_…' \
  -d grant_type=authorization_code \
  -d code=crm_ac_… \
  -d redirect_uri=https://yourapp.example/oauth/callback \
  -d code_verifier=…
```

The body is form-encoded. The client can authenticate with HTTP Basic, as here, or with
`client_id` and `client_secret` in the body, but not both. The answer:

```json
{
  "access_token": "crm_at_…",
  "token_type": "Bearer",
  "expires_in": 86400,
  "refresh_token": "crm_rt_…",
  "scope": "tags.configure tags.manage"
}
```

`scope` lists the permissions the install was granted. The token works in the business
that installed the app, and nowhere else.

## 4. Call the API

```sh
curl https://crm.example.com/api/v1/tags -H 'Authorization: Bearer crm_at_…'
```

The API is the same one people and API keys use, and its OpenAPI document is at
`/api/v1/openapi.json`. Asking for another business with `Business-Id` or `Business-Slug`
is refused with 403. A token that has expired or was revoked gets 401 with
`WWW-Authenticate: Bearer error="invalid_token"`. A request beyond what the app was granted
gets 403. What the app does is recorded under its name in the business's activity and
audit log.

Some endpoints are for people only, such as API keys, AI settings and the audit log. An
app can't use them, whatever it was granted.

## 5. Refresh

An access token lasts 24 hours and a refresh token lasts a year. Trade the refresh token
for a new pair:

```sh
curl https://crm.example.com/oauth/token \
  -u 'mapp_01k8…:crm_cs_…' \
  -d grant_type=refresh_token \
  -d refresh_token=crm_rt_…
```

Each refresh token works once. Save the new one the answer gives you. If a refresh token
that was already used is presented again, the CRM treats it as stolen and revokes every
token that came from the same code. The app then has to send the person through step 2
again.

## 6. Revoke

To disconnect from your side, revoke either token of a pair
([RFC 7009](https://www.rfc-editor.org/rfc/rfc7009)). The whole pair and everything
refreshed from it stop:

```sh
curl https://crm.example.com/oauth/revoke -u 'mapp_01k8…:crm_cs_…' -d token=crm_rt_…
```

The answer is 200 whether or not the token was known.

## 7. Webhooks

The agency can give the app a **webhook address** (`https://`, port 443) and choose the
events it is told of. Each event belongs to a part of the API the app must be able to read:
contact events need *Contacts*, opportunity events *Deals*, and so on. Every app with an
address is also told when it is installed (`app.installed`) and uninstalled
(`app.uninstalled`). **Generate webhook secret** on the app's Connection panel shows the
signing secret once.

Each event is one `POST` of JSON:

```json
{
  "type": "contact.created",
  "occurredAt": "2026-10-17T09:00:00.000Z",
  "appId": "mapp_01k8…",
  "installId": "mins_01k8…",
  "businessId": "biz_01k8…",
  "subject": { "kind": "contact", "id": "con_01k8…" }
}
```

The body names what happened and to which record, but not the record's contents. Read the
record through the API with that business's access token, which allows only what the
business granted. `subject` is `null` for `app.installed` and `app.uninstalled`.

The events: `contact.created`, `contact.updated`, `tag.assigned`, `tag.removed`,
`deal.created`, `deal.stage_changed`, `deal.won`, `deal.lost`, `appointment.booked`,
`appointment.rescheduled`, `appointment.status_changed`, `appointment.cancelled`,
`form.submitted`, `message.received`, `task.created`, `task.completed`, `note.created`,
`invoice.paid` and `payment.recorded`.

### Checking a delivery

Every request carries three headers:

| Header | Holds |
|---|---|
| `X-CRM-Delivery` | The delivery's id, the same on every attempt |
| `X-CRM-Timestamp` | When this attempt was signed, in Unix seconds |
| `X-CRM-Signature` | `v1=` and the HMAC-SHA256, in hex, of the timestamp, a dot, and the raw body |

Check the signature against the raw body, before parsing it, and refuse an old timestamp:

```js
import { createHmac, timingSafeEqual } from 'node:crypto';

function isFromTheCrm(secret, timestamp, rawBody, signature) {
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return false;
  const expected = `v1=${createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex')}`;
  return (
    expected.length === signature.length &&
    timingSafeEqual(Buffer.from(expected), Buffer.from(signature))
  );
}
```

### Answering

Answer with any `2xx` status within 10 seconds. A timeout, a network error, `408`, `429`
or a `5xx` is tried again: after 1 minute, then 2, 4, 8 and 16, six attempts in all.
`Retry-After` on a `429` or `503` can lengthen a wait, up to an hour. Redirects are not
followed, and other statuses are not retried. A delivery may arrive more than once, so use
`X-CRM-Delivery` to ignore a repeat.

The agency sees the latest deliveries on the app's Connection panel, with each one's status
and last answer, and can send one again. Deliveries are kept for 30 days.

## When access ends

- **The business uninstalls the app.** Every token stops at once, and so do codes not yet
  traded. The app is told by `app.uninstalled`, and of nothing after it.
- **The business is suspended or archived.** Tokens stop working while it is.
- **The agency delists the app.** Nothing changes for businesses that have it. No new
  business can install it.

Tokens belong to the business, not to the person who allowed the app. They keep working
if that person leaves the business.

## Errors from the token endpoint

The token and revocation endpoints answer errors as RFC 6749 section 5.2 describes:

| Error | Status | Means |
|---|---|---|
| `invalid_request` | 400 | A parameter is missing or sent twice, the body isn't form-encoded, or the client authenticated two ways |
| `invalid_client` | 401 | The client ID or secret is wrong |
| `invalid_grant` | 400 | The code or refresh token is unknown, expired, used already, for another app, or for another redirect address, or the verifier doesn't match |
| `unsupported_grant_type` | 400 | Only `authorization_code` and `refresh_token` are accepted |

Requests to these endpoints share the CRM's limit for public requests. Too many get 429,
with `Retry-After`.
