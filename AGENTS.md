# codex-claude-status-bar

<!-- doctrine:begin v1 — managed by ~/.claude/hooks/init-doctrine.py; canonical: ~/.claude/DOCTRINE.md -->
## Programming Doctrine (base standard — takes precedence)

Applies to every project. Canonical full text: `~/.claude/DOCTRINE.md`.
Written for PHP/Laravel + ERP; the principles are stack-neutral — translate the names
(Laravel → this project's framework, Eloquent → its data layer, PHPStan → its type checker,
Pest → its test runner, Deptrac → its import-boundary lint). Where the doctrine and a local habit
of this repo disagree, the doctrine wins — and you name the conflict out loud.

**0. Code language — English, absolutely, no exceptions.** Outranks every point below and is not
subject to the tie-breakers. Identifiers, comments, docblocks, commit messages, branch names, test
names, log messages, config documentation, internal docs: English. The conversation may run in
Czech, in English or in a mix — that changes nothing about the code. A Czech question does not
license a Czech identifier or a Czech comment.

The only text that stays in another language is what an end user reads: UI labels, admin field
descriptions, front-end copy, translation files, seeded content. Files generated from those labels
(typed schemas, for instance) inherit that language legitimately — do not "fix" them. And never
rename an identifier that an external system references by name (import expressions, option and meta
keys, hook names, database columns) merely to anglicise it: that breaks the integration, and point
17 asks for one stable name per thing, not a prettier one.

**I. Reduction.** 1 YAGNI — only what is needed today; an interface with one implementation, an
unused `options` parameter, a config key with no second value = violation. 2 KISS/Occam — take the
dumber of two solutions; nested ternaries, three layers of abstraction over one query = violation.
3 DRY only after the third occurrence — DRY is about knowledge, not similar-looking characters; two
identical bodies with different reasons to change must not be merged. 4 Delete > refactor > rewrite
— dead code, commented-out blocks, unused feature flags and "temporary" endpoints go now;
`// old version`, `// TODO: remove` = violation. Git is the history.

**II. Platform.** 5 Framework first — whatever the framework does, do not rewrite (routing, auth,
validation, queue, ORM/CMS layer). 6 A package with traction beats your own implementation, but a
dependency is a commitment: you take one on for a problem you cannot solve well yourself, not for
thirty lines. A custom CSV parser and a custom facade over someone else's API are both violations.
7 Convention over Configuration — configuration appears when somebody actually needs to deviate,
not preventively. 8 Registration over Hardcoding — a `switch` with 40 cases, or a config array
extended by hand for every new type = violation.

**III. Structure.** 9 Screaming architecture — folders scream the domain, not the framework;
`Helpers`/`Utils` is a dumping ground, not a category. 10 Bounded contexts — own models and own
language per context, shared through explicit interfaces and events; a unit importing from five
different domains = violation. 11 SRP — one reason to change; if you describe a class or component
using the word "and", split it; `Manager`/`Processor`/`Handler` without qualification = violation.
12 Composition over Inheritance — at most one level of inheritance, behaviour is injected.
13 Explicit dependencies — everything passed in explicitly; the domain knows nothing about HTTP or
the database (a `request` threaded deeper than the route handler, `notFound()`/`abort` inside a
domain function = violation).

**IV. Data and errors.** 14 Single Source of Truth — one authoritative source per fact, everything
else derived; denormalisation only as a measured decision with an idempotent recompute on demand.
15 Fail fast, loudly — validate at the boundary, assume valid data inside; an empty `catch` and
`return null` instead of an exception = violation. 16 Money, time and quantities are not floats —
integer representation, explicit currency, explicit timezone, explicit unit. 17 Ubiquitous language
— the same term in code, database, UI and in conversation with the customer; no abbreviations, no
two names for the same thing across layers.

**V. Process (critical for AI-generated code).** 18 A test is a contract, not decoration — the human
defines the spec and the test, the model writes the implementation; a test written by the same agent
in the same pass only tests itself; a test that changes during a behaviour-preserving refactor is
not testing the domain. 19 One commit = one idea; review AI code more strictly than human code — it
is fluent, confident and capable of being systematically wrong; Boy Scout Rule: leave every file you
touch cleaner. 20 Do not optimise without measuring — but N+1 queries, missing indexes and wasteful
aggregations are defects, not optimisations; least privilege and input validation are the default,
not a project phase.

**Tie-breakers.** DRY vs. bounded contexts → do not merge the same word with a different meaning;
DRY applies inside a context, not across. Framework first vs. your own layer → respect for the
framework is cheap for infrastructure; the boundary runs where the domain must not hang off vendor
conventions. YAGNI vs. domain correctness → accounting, VAT, audit trail and currencies cannot be
retrofitted; do not scale extensibility ahead of time, do scale correctness. KISS vs. SRP → split by
reasons to change, not by line count; three classes turned into twelve means KISS lost. AI speed vs.
points 18–19 → generate slower, do not review faster.
<!-- doctrine:end v1 -->
