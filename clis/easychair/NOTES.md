# EasyChair chair-side adapter — field notes

Reverse-engineered from a live chairing session (first built against CCIR2026, but
the adapter is conference-agnostic). EasyChair has no public API for chair
operations, so everything here drives the logged-in web UI through the opencli
browser session. These notes capture the DOM map, the non-obvious *write* recipes,
and the traps — keep them next to the adapters.

## Auth & conference selection

- All chair pages live under `https://easychair.org/conferences2/<page>?a=<CONF>`.
- `a=<CONF>` is a numeric token identifying **one role on one conference for one
  account** (e.g. the chair role). It is NOT the conference acronym, and it is not
  stable across accounts/roles.
- Nothing is hardcoded. Pass `--conf` (or set `EASYCHAIR_CONF`) as either:
  - a numeric `a=` id → used directly, or
  - an acronym/slug (e.g. `ccir2026`, `SIGIR 2026`) → resolved at runtime.
- **Acronym → a= resolution** (`_conf.js`): open `my/conferences`, match the row by
  normalised acronym/slug to get its `conf=<slug>`; open `my/conference?conf=<slug>`;
  read the role links (each carries its own `?a=<id>`) and pick the one matching
  `preferRole` (default `chair`), else the first. `opencli easychair conferences`
  lists acronym+slug for discovery.
- Auth is **cookie / session only** — you must log in manually in the browser once.
  `Strategy.COOKIE` reuses that session. Sessions log out silently: the page then
  has `document.title === "Log in to EasyChair"` and the data tables are empty.
  Every adapter checks the title first and raises `AUTH_REQUIRED` if logged out.

| `my/...` page (no `a=`) | What it gives |
|-------------------------|---------------|
| `my/conferences`        | every conference you touch: `#`, acronym, `conf=<slug>` link, name |
| `my/conference?conf=<slug>` | that conference's role links, each with its own `?a=<id>` (chair/author/…) |

## Page map (chair role)

| Page (`?a=<CONF>`)        | What it gives | How to parse |
|---------------------------|---------------|--------------|
| `review_bysubmission`     | # / title / assigned / reviews / missing | `a[href*="submission_reviews"]` → `closest('tr')`; cells `[num,title,assigned,reviews,missing]`; id from `submission=(\d+)` in href |
| `status`                  | # / authors+title / scores / avg / decision | same anchor; cells `[num, authorsTitle, scores, avg, decision]`. **Cell layout differs from bysubmission** — index 2/3 are scores/avg here, not assigned/reviews |
| `review_bymember`         | name / role / assigned / reviews / missing | iterate `tr`; a data row is exactly 5 `td` whose last three are all digits. Blank role cell = ordinary PC member, else `chair` |
| `review_missing`          | reviewer / last login / submissions still owed | `a[href*="pcmember_info"]` → `closest('tr')`; `member=(\d+)` gives the **numeric member id**; owed submissions = leading `\d+\.` numbers in the last cell |
| `pc_show`                 | first / last / email / affiliation / role / last access | row `td`s, length ≥ 6, where cell[4] matches `chair|PC member` |
| `assignment_submission?...&submission=<sid>` | one AJAX checkbox per PC member | checkbox `id="m<memberId>"`, `name="pc"`; reviewer name = `closest('tr').children[0]` |
| `email_pc`                | compose mail to PC | `#subject`, `#body` (textarea); recipient checkboxes `id="<memberId>"` (no `m`), `name="pc"` |
| `emails`                  | audit log of all sent mail | rows of subject + recipients + UTC time. Use to **verify** a send |

`score(confidence)` formatting on `status`: e.g. `3(4),3(5)` = two reviews, scores 3
and 3 with confidence 4 and 5. `avg` is the plain numeric mean (can be negative).

## Scores scale (CCIR2026 overall recommendation)

`3 strong accept · 2 accept · 1 lean accept · 0 neutral · -1 lean reject · -2 reject · -3 strong reject`.
Confidence/expertise is the parenthesised number, 1 (none) … 5 (expert).

## The big trap: writes are AJAX, not form posts

`opencli browser eval` returns `{session, data}` — always read `result.data`.

Two chair write paths, both routed through EasyChair's own JS helpers rather than a
normal `<form>` submit. Driving the visible controls the "obvious" way fails:

- `opencli browser check "#m<id>"` → `not_checkable` (the click is `preventDefault`-ed).
- A plain `element.click()` flips the box visually but **does not persist**.
- Numeric ids are not valid CSS selectors: `#3770785` throws. Use
  `getElementById('3770785')` or `[id="3770785"]`.
- Submit-button ids (`bf<NNNNN>`) are **regenerated on every page load** — never
  hardcode them; query `input[type=submit]` fresh each time.
- Returning a Promise straight out of `eval` can report "operation aborted". Prefer
  fire-and-forget + reload-and-verify, or stash to `window.__x` and poll.
- Allow ~1.5–2 s after firing an XHR before reloading to verify.

### Assigning a reviewer (implemented in `assign.js`)

```js
// on assignment_submission?a=<CONF>&submission=<SID>
loadObject('/conferences2/assignment_submission_x', function(){}, {
  submission: '<SID>', checked: 1 /* 0 to remove */, bid: 'm<MEMBER_ID>'
});
// then reload the page and confirm getElementById('m<MEMBER_ID>').checked
```

Verify out-of-band too: the paper's `assigned` count on `review_bysubmission` goes up
by one. Assigning does **not** notify the reviewer.

### Emailing PC members (kept manual — NOT a CLI command)

Personalised, multi-line bodies and irreversible delivery make a one-shot CLI flag
a foot-gun, so this stays a documented recipe rather than an adapter. It is a
**two-step** confirm flow:

```js
// 1. on email_pc?a=<CONF>
//    fill #subject and #body (body may use [*FIRST-NAME*] / [*LAST-NAME*] vars)
getElementById('<MEMBER_ID>').checked = true;          // recipient(s); id has NO 'm' prefix here
const b1 = document.querySelector('input[type=submit]');
FormHandler.ajaxForm({currentTarget:b1, preventDefault(){}}, '/conferences2/email_pc_x', {});
// → lands on a "Confirm Email Sending" preview (renders one resolved instance)

// 2. on the confirm page
const b2 = document.querySelector('input[type=submit]');
FormHandler.ajaxForm({currentTarget:b2, preventDefault(){}}, '/conferences2/email_pc_confirm_x', {});
// → returns to a blank compose form on success
```

Then open `emails?a=<CONF>` and confirm one log row per recipient at the expected
time. Re-open `email_pc` between sends — the form does not reset state cleanly if you
keep firing on the same page instance.

## Identity / duplicate names

PC member **names are not unique** (CCIR2026 had two "Peiyu Liu", two "Chuanjun Zhao",
two "Beining Wang"). The `members` table is keyed by row order only. Whenever you must
act on a specific person, resolve their **numeric member id** first — `easychair missing`
exposes it directly (`memberId`), and the assignment page encodes it in the `m<id>`
checkbox. Never match a person by name alone for a write.

## Cross-checks worth running

- A paper's `missing` should equal `assigned − reviews`.
- `review_missing` member ids should round-trip: feeding `memberId` into
  `assign --action add/remove` toggles exactly that person.
- After any assignment batch, re-pull `submissions` and confirm `assigned` moved.
