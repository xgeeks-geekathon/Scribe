# Scribe

> Team: "Temporary Team Name"
> Members:
>   - Luís Tonicha @lud0v1c
>   - Tiago Dias @tiagoad

>Short Demo: https://www.youtube.com/watch?v=wWC4lQWZbcE

> **Last minute warning: As we've mistakenly pushed the OpenAI and Slack keys to
> the repo, it seems OpenAI and Slack have [automatically cancelled them](https://docs.github.com/en/code-security/secret-scanning/about-secret-scanning) :(**

A chat bot powered by OpenAI's GPT-4 Turbo model to automate incident reporting. It monitors a Slack channel and generates a Google Docs document which is tracked and kept updated.

It does this by leveraging the newly released "gpt-4-1106-preview" model and [function calling](https://platform.openai.com/docs/guides/function-calling), which allows it to have access to some tools, in this case that let it modify a Google doc.

Slack channel content is fed to these functions, which are then parsed and the appropriate [Google Docs API calls](https://developers.google.com/docs/api/reference/rest) are made.

### Workflow

Once the bot is brought into a Slack channel, it immediately starts watching for new messages. Every time a user sends something, if it's not related to a previous issue, Scribe:

1. Creates a copy of the templated Google document;
2. Fills it with what the user reported;
3. Replies back to the user with the doc's URL.

If a message's context is identified as an update, Scribe will append these updates to the Google document, in a log fashion.

### Google Document template

The Google document template has the following sections:

- **Title**;
- **Priority**: Ranges from 0 (critical) to 5 (minimal impact);
- **Status**: Divided in "internal" (for people directly managing the incident) and otherwise, for other people in the company interested in the big picture;
- **Remediation**: Steps taken to mitigate the issue;
- **Impact**: Services and/or resources affected;

These sections are dynamically updated based on the output from the ChatGPT model. We instruct it to keep a very concise and formal attitude, filtering non issue related conversation.

## Usage

1. Clone the repository:

```bash
git clone https://github.com/xgeeks-geekathon/team-tmpteamname-scribe.git
cd scribe
```

2. Install dependencies:

```bash
npm install # >= 20.9.0 recommended
```

3. Set up [your Slack App](https://www.twilio.com/blog/how-to-build-a-slackbot-in-socket-mode-with-python) and [Google API credentials](https://developers.google.com/identity/protocols/oauth2). Make sure the Slack app is using Socket Mode with the appropriate bot events and OAuth scopes.

4. Export environment variables:

```bash
SLACK_SIGNING_SECRET=your_slack_signing_secret
SLACK_BOT_TOKEN=your_slack_bot_token
GOOGLE_CREDENTIALS_PATH=./google-credentials.json
```

5. Run `scribe.sh`

```bash
cd scripts/
./scribe.sh
```
