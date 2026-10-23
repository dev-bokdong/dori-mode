# Onboarding

Run once, right after the bot greets the owner. The aim is to learn enough about the owner, their work and their company that you can act without asking about basics.

## 1. Ask for consent first

Before you read anything, send this (in the owner's language):

> To help you well I first need to learn how you work: which tools you use, what you're working on and why, and who you and your company are. That's what lets me do real work for you. May I go through your tools to learn this?

Wait for the answer. If it is no, record that onboarding was declined and stop. Ask again only if the owner brings it up.

## 2. Find the owner's main tools

Look only at what is visible without opening anyone's data: installed CLIs, logged-in apps, the platforms agent-messenger supports, config files that name a workspace. Usual candidates:

- messengers: Telegram, Discord, Slack, KakaoTalk, LINE
- docs and knowledge: Notion, Google Docs, Confluence
- tickets: Linear, Jira, GitHub Issues
- code: GitHub, GitLab
- mail and calendar: Gmail and Google Calendar, Outlook

## 3. Ask per tool, explaining each integration

For each tool, say which integration you would use, what it reads, and why. Ask for that tool alone. For example:

> zele is a CLI that reads your Gmail and Google Calendar, so I can keep an eye on your schedule and your mail. Allow?

> agent-slack reads your Slack workspaces (channels, threads, DMs you're in) so I learn who you work with and on what. Allow?

> The GitHub CLI (gh) reads your repos, issues and pull requests so I know what you're building. Allow?

If the messenger is Slack, the token choice from setup also sets what onboarding can read there. A user token sees what that member sees. A bot token sees only the channels it was invited to, so ask the owner to invite it where the real work happens.

A no skips that tool. Remember every no, and do not ask about that tool again unless the owner raises it.

## 4. Crawl each allowed tool in depth, read-only

Read; never post, react, edit, mark read, accept or send. Go deep enough to understand the work, not only the titles:

| Tool | Read |
|---|---|
| messengers, Slack | the busiest channels and threads of the last few weeks, pinned messages, who talks to whom about what |
| Notion, docs | top-level pages, databases and their recent rows, anything named roadmap, plan, OKR, strategy, onboarding |
| Linear, Jira | open projects, active cycles, issues assigned to or created by the owner |
| GitHub | repos the owner pushed to recently, open PRs and issues, READMEs |
| mail, calendar | recurring meetings, the next two weeks, frequent correspondents (subjects, not full bodies, unless the owner allowed bodies) |

## 5. Write memory as you go

Write it down as soon as you learn something, instead of saving it all for the end:

- **work:** active projects, what each is for, current goals and deadlines;
- **persona:** the owner's role, how they write, what they care about, what they dislike;
- **company:** what it does, products, customers in general terms, the people the owner works with most and their roles;
- **tools:** which tools are allowed, which were declined, and where things live.

Keep secrets, tokens and other people's private messages out of memory. Record facts and where to find them.

## 6. Report back

Send one short summary: what you now know (work, goals, persona, company), which tools you used, which ones you skipped because the owner declined, and the gaps you could not fill. Ask about the gaps only if they block real work.
