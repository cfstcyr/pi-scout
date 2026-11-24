# pi-scout

**A sidekick that finds what an AI agent doesn't know it's missing.**

pi-scout is an add-on for the [pi](https://pi.dev) AI agent. It runs next to the agent while it works, searches your
files and tools on its own, then hands the agent a short list of places worth checking. The agent decides what to open.

Visual explainer: **https://cfstcyr.github.io/pi-scout/**

## The problem

Ask an AI agent to write a client email from a folder of 3,000 notes. It reads what looks relevant and gets to work.
The note that matters (a newer price, a decision from a meeting, a correction in a chat) often uses different words,
so the agent never opens it and writes the old answer.

When someone points the agent to that note, it nearly always uses it. **Finding it is the hard part.**

## How it works

Two workers run side by side. The **agent** does the task. The **scout** is a separate, cheaper AI that only searches.

1. **You give a task.** The agent starts reading and exploring, as it always would.
2. **The scout searches, in parallel.** It plans searches, runs them across your files and tools, and picks the best
   leads.
3. **About 8 seconds later, it drops one short list into the agent's conversation.** The agent opens the leads that
   look useful and finishes the task with what it found.

The list points to places: a file or message, its date, and whether something newer exists on the same subject.

```text
Scout: places worth checking
1. emails/harbour/2026-03-02 re: launch timing.txt   Mar 2  · newer than 2
2. plans/launch-plan-v3.md                           Jan 10 · older
3. ticket #4117 "Pricing exception" (helpdesk)       Feb 28
4. notes/2026-02-14 steering committee.md            Feb 14
```

The dates and "newer than" links let the agent tell a current note from an outdated one.

<details>
<summary>How the scout searches</summary>

Each time you give a task, the scout makes three calls to a small, fast AI model (Claude Haiku in the tests):

- **Plan:** from the task and an overview of the folder, it writes many searches: synonyms, the other language
  (English/French), names of people and clients, and how a rule or a correction would be worded.
- **Gather:** it runs them on files, history and connected tools, adds the newest files of the folders it picked, and
  summarises about 100 candidates in a line or two each.
- **Judge and follow up:** it keeps the most promising ones, runs a second round of searches based on what it found,
  and keeps up to 12. Copies of the same file are merged, newest first.

The list skips anything the agent has already opened. One list per task. If the agent finishes before the search does,
the list is delivered once at the end. Short prompts ("ok", "thanks", commands) start no search.

</details>

## Where it looks

| Source | What |
|---|---|
| **Files** | The files in the folder the agent works in: notes, docs, emails saved as text, data files |
| **History** | Commit messages, when the folder is a git repository |
| **Connected tools** | Search tools you list in a config file: tickets, CRM, team chat, web search |

<details>
<summary>Privacy and safety rules</summary>

- **Files only by default.** A tool is searched only if you list it in `~/.pi/agent/scout-sources.json`, and only its
  read-only search and fetch functions are used.
- **Same AI provider as your session.** Short summaries of candidates go to the smallest model of the provider you
  already use (or a model you name). If there is none, it searches without any AI model and says so.
- **Secrets stay out.** Secret-looking files (`.env`, keys, credentials) are never read, and passwords, keys and tokens
  inside other files are blanked out before anything reaches the model.
- **Web searches get only your own words.** Names and details from your files are never sent to public search.
- **Public pages stay in their place.** At most 3 web results per list, and a web page can never mark one of your own
  documents as outdated.
- **Limits on every run:** capped tool calls, a few seconds per call, and a token budget per session.
- **Log** in `~/.cache/pi-scout/`, never in your folder. It holds queries and ids, not file contents.

</details>

## How well it works

It was tested on generated folders (notes vaults, wikis, shared drives, code repos, ticket and chat systems), each
hiding one note the task depends on. The numbers are how often the agent's final answer used that note.

| Test | Agent alone | Agent + scout |
|---|---|---|
| Big folders (6 new folders, 2,000–4,000 files) | 33 % | **88 %** |
| Final blind test (8 unseen folders, small and big) | 45 % | 53 % |
| Current version (25 practice folders) | 54 % | 66 % |

- **Big folders gain the most.** In small folders the agent already reads nearly everything on its own.
- **The final blind test shows a small gain** that could still be chance; its big folders went from 36 % to 58 %.
- **It stayed safe:** answers were never worse overall, a booby-trapped web page was never followed, and the scout
  never changed anything.
- **It costs little:** about 10–25 thousand tokens of a small model per task, and the main agent used about 40 % fewer
  tokens because it explored less.

<details>
<summary>How it was tested, and what the numbers measure exactly</summary>

- Each test folder hides one key note, written with different words from the task, among decoys such as an outdated
  "official" version and near-duplicates. A script checks the final answer.
- Every setup runs side by side on the same folders: the agent alone, the agent with the scout, and the agent given the
  key note directly (the best possible case).
- The scout was frozen before each test and the pass rule was written down in advance. Each blind set was used once.
- The agent in all tests was Claude Haiku 5.5, in a sandbox that could only see its own folder.
- **Big folders:** 24 runs per setup, +54 points, p < 0.001; the agent given the note directly reached 92 %. Measured
  with the previous version, where the agent asked for the list itself.
- **Final blind test:** 96 runs per setup, +8 points, p = 0.29; big folders only +22 points, p = 0.10. Same previous
  version.
- **Current version:** 50 runs per setup; within 4 points of the previous version while delivering the list on its own.
  Main-agent tokens: 195k against 337k for the agent alone.

</details>

## Limits

- **Tested on generated folders** with one agent model; real notes are messier.
- **The list can include an outdated document.** The dates and "newer than" links usually steer the agent to the
  current one, but not every time.
- **It adds a few seconds** before the list arrives, and pays off mainly in folders too big to read entirely.

## Install

```sh
pi install git:github.com/cfstcyr/pi-scout        # every pi session
cd <big-folder> && pi install -l git:github.com/cfstcyr/pi-scout   # this folder only
pi -e git:github.com/cfstcyr/pi-scout             # try it for one session
```

No runtime dependency besides pi. `SCOUT_DISABLE=1` turns it off for a session, and `/scout` shows its state.

## Configure (optional)

Without a config file, the scout searches the folder's files and git history only. To add connected tools, create
`~/.pi/agent/scout-sources.json` (full example: [`scout-sources.example.json`](scout-sources.example.json)):

```json
{
  "mcp": {
    "crm":     { "route": "client", "searchTools": ["search_notes"],   "fetchTools": ["get_note"],   "external": false },
    "tickets": { "route": "client", "searchTools": ["search_tickets"], "fetchTools": ["get_ticket"], "external": false },
    "web":     { "route": "client", "searchTools": ["web_search"],     "fetchTools": ["fetch_page"], "openWorld": true }
  }
}
```

- Names are entries from your `~/.pi/agent/mcp.json`; list each server's read-only search and fetch tools.
- `"external": false` marks your own business tools (CRM, tickets, team chat); `"openWorld": true` marks public
  sources such as web search.

<details>
<summary>All settings</summary>

```jsonc
{
  "research": {
    "enabled": true,               // background search on task-like prompts
    "llm": true,                   // false = search without any AI model
    "model": "provider/id",        // or "session"; default: the session provider's small model
    "minTaskTerms": 5,             // content words for a prompt to count as a task
    "maxRunsPerSession": 30, "maxTokensPerSession": 600000, "maxTokensPerRun": 40000, "ledgerWaitMs": 15000
  },
  "delivery": "push",              // "pull" = the agent gets a `scout` tool, a guideline and a reminder instead
  "tool": false,                   // true = also give the agent a `scout` tool
  "map": { "maxExternal": 3 },     // web results per list
  "calls": { "perServer": 12, "total": 30, "perCallMs": 3000, "breakAfter": 2, "perPrompt": 60 },
  "mcp": { },
  "deny": []
}
```

- A project file `.pi/scout-sources.json` (trusted projects only) can only restrict: turn the search off, lower caps,
  deny servers.
- Environment variables for testing: `SCOUT_DISABLE`, `SCOUT_DELIVERY`, `SCOUT_TOOL`, `SCOUT_RESEARCH=0`,
  `SCOUT_QUERY_MODEL`, `SCOUT_LOG`, `SCOUT_SOURCES` (another config file).

</details>

## Develop

```sh
bun test test/          # unit tests, no network
test/smoke/smoke.sh     # real pi with a scripted fake model, fake folder, isolated agent directory
```

The extension entry point is `src/extension.ts`; the background search is `src/research.ts`, the list is built in
`src/map7.ts` and delivered by `src/push.ts`, and the sources live in `src/sources/`.
