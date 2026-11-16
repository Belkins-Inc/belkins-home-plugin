---
name: linkedin-comments
description: Your own Claude writes the warm-up comments of the managed LinkedIn accounts set to comment — one short, fitting comment under a post in each account's feed, as many a day as the account is set to (`bh linkedin warmup`) — on a schedule in the Claude desktop app. The engine likes posts and accepts invitations by itself but never writes a comment. Use when the scheduled task fires, when asked to comment for an account, and to set the schedule up on a new computer.
---

# LinkedIn comments

A managed LinkedIn account warms by itself: the engine likes a few posts a day and accepts the
invitations people send it. A comment is words in a person's name, so the engine never writes one;
you do, from the account's own feed, and the engine posts it on the account's own IP and keeps it in
the account's history.

## Set up the schedule (once per computer)

An organisation admin's computer (the feed and the comment are an admin's acts). In the Claude
desktop app, a scheduled task runs this skill every hour while the app is open; a run outside an
account's working hours (9:00 to 18:00 where its IP stands) leaves it for the next. Create it with
the scheduled-tasks tool (`create_scheduled_task`), or in the app's Scheduled tab:

- `taskId`: `belkins-linkedin-comments`; title: `Belkins LinkedIn comments`;
- `cronExpression`: `17 * * * 1-5` (a minute past the hour nobody else picks, working days);
- the working directory: the person's Belkins Home workspace (`~/work/belkins-home`, whose
  `.claude/settings.json` allows `Bash(bh *)`), so the run asks for no permission;
- `prompt`: `Use the belkins-home:linkedin-comments skill: comment for every account that has
  comments left today. End with one line: who commented on what.`

## A pass

1. `bh linkedin accounts <org>` (`belkins` for the agency's network): the accounts whose `warmup`
   has `commentsADay` above 0 and whose `status` is `active`. None → end with "Nothing to comment".
2. For each, `bh linkedin feed <id>`. `commentsLeft` 0 or `open` false → next account. It spends two
   of the account's LinkedIn requests, so look once a pass, not again to compare.
3. Pick one post from `posts`, the one this person could answer best — something in their line of
   work (`bh linkedin show <id>` names them; their title is on `bh agency senders <org>`) that you
   understood and have a real thought on. Pass over: politics, religion, health, tragedy, layoffs
   and job hunting, celebrations of someone's personal news, anything you would need to guess at,
   posts in a language you would write badly, and a post by one of the agency's clients or by a
   company you know it writes to. Nothing fits → write nothing today for that account.
4. Write the comment in the post's language, as that person would under it:
   - one or two sentences, 15 to 300 characters, one paragraph;
   - about this post: pick up one point it makes and add a fact, an angle or a short question of
     your own — never "Great post", "Thanks for sharing", "So true" or a summary of the post;
   - plain words, no emoji or one at most, no hashtags, mentions, links or domains;
   - never what the account's company sells, a call to talk, or a pitch of any kind.
5. `bh linkedin comment <id> --post <postId> --text "<comment>" --url "<url>" --author "<author>"`.
   A refusal says why; fix the text when it is the text, else leave the account for the next pass.
   Never comment twice in one pass, and never retry a comment LinkedIn refused for its limit (the
   account rests by itself).

End with one line per account: the author and the first words of what was said, or why nothing was.
