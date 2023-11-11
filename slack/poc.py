# Uses SocketMode - needs to be enabled and bot events too.
# Check https://www.twilio.com/blog/how-to-build-a-slackbot-in-socket-mode-with-python
from slack_bolt import App
from slack_bolt.adapter.socket_mode import SocketModeHandler
import os

SLACK_BOT_TOKEN = os.environ.get("SLACK_BOT_TOKEN")
SLACK_APP_TOKEN = os.environ.get("SLACK_APP_TOKEN")
app = App(token=SLACK_BOT_TOKEN)

@app.event("app_mention")
def mention_handler(body, say):
    say(f"Thanks for reporting an issue <@{body['event']['user']}>. A report titled \"{body['event']['text']}\" was created <here>")

if __name__ == "__main__":
    handler = SocketModeHandler(app, SLACK_APP_TOKEN)
    handler.start()
