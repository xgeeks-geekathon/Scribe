import { UsersInfoResponse } from "@slack/web-api";
import dayjs from "dayjs";
import { docs_v1, drive_v3, google } from "googleapis";
import util from "node:util";
import OpenAI from "openai";
import { ChatCompletionMessageParam } from "openai/src/resources/chat/completions";
import { authorize } from "./google";
import { getOpenAI } from "./openai";

import utc from "dayjs/plugin/utc";
dayjs.extend(utc);

import { App as SlackApp, SlackEventMiddlewareArgs } from "@slack/bolt";

import ChatCompletionTool = OpenAI.ChatCompletionTool;
import Drive = drive_v3.Drive;
import Docs = docs_v1.Docs;

const TEMPLATE_FILE_ID = "10z30aQruINuaH0sPuZuOSKKXpCFvEQ2OjJ15RvTd-HQ";
const INCIDENT_FOLDER_ID = "1DvyCIFQJpQWhHayUOw28TmfA_26vf1Ja";

const SLACK_BOT_TOKEN =
  "xoxb-6183999878612-6181542032307-hjDwfSXjnd7YY9rxADe6muoF";
const SLACK_APP_TOKEN =
  "xapp-1-A065Q81J00H-6178724373941-568f7173feec6c9ce32fd350c2cc9e5fdc0bf251ed7b9c67a7ed00827c0e7bb0";

const SYSTEM_INSTRUCTIONS = `
- You are a chat bot in charge of updating a live google document with the ongoing updates of an event being managed in a channel. 
- You should be very concise and stay out of the way. 
- All your input should reflect accurately what's being said in the channel you're monitoring, and you should not input any judgment or opinion. 
- You should ignore irrelevant conversations. 
- You don't have the capability to send messages to the chat, only to call the tools provided to you. Error messages and such copied info should be relayed verbatim, unless overly verbose.
- You must always translate everything to English, even if participants use other languages.
- You will receive the following types of input (between quotes, <something> is a placeholder, the "<>" are not literal):
  - "New channel" (when joining a new channel. assume nothing has been changed until this point, so update the title and other settings as soon as you get any info-)
  - "<user>: <message>" (when a message is received, replace <user> with the user name, and <message> with the message)
  - "<user> joined" (when a user joins the channel)
`;

const TEMPLATE_INJECTIONS = {
  title: "{title}",
  priority: "{priority}",
};

const KV = {
  users: {} as {
    [uid: string]: UsersInfoResponse;
  },
  convos: {} as {
    [chatId: string]: {
      gdocId: string;
      messages: ChatCompletionMessageParam[];
      inbox: string[];
    };
  },
};

const TOOL_APPEND_PARAMS = {
  type: "object",
  properties: {
    text: {
      type: "string",
      description: "The text to append",
    },
  },
  required: ["text"],
};

export class IncidentBot {
  private gdrive: Drive;
  private gdocs: Docs;
  private openai: OpenAI;
  private slack: SlackApp;

  constructor() {
    this.openai = getOpenAI();
    this.gdocs = google.docs({
      version: "v1",
    });
    this.gdrive = google.drive({
      version: "v3",
    });

    this.slack = new SlackApp({
      token: SLACK_BOT_TOKEN,
      appToken: SLACK_APP_TOKEN,
      socketMode: true,
    });
  }

  // Main //

  async init() {
    // google auth
    const auth = await authorize();
    this.gdocs.context._options.auth = auth;
    this.gdrive.context._options.auth = auth;

    // hook slack events
    this.slack.event("message", async (e) => {
      await this.onMessage(e);
    });
    this.slack.event("member_joined_channel", async (e) => {
      if (e.event.user === e.context.botUserId) {
        await this.onAdded(e);
      }
    });
    this.slack.event("member_left_channel", async (e) => {
      if (e.event.user === e.context.botUserId) {
        await this.onRemoved(e);
      }
    });

    // connect slack webhook
    this.gptLoop().then();
    await this.slack.start();
  }

  async gptLoop() {
    while (true) {
      for (const [channel, convo] of Object.entries(KV.convos)) {
        let msg;
        while ((msg = convo.inbox.pop())) {
          // handle message
          const newMessage = {
            role: "user" as const,
            content: msg,
          };

          insp(newMessage);
          convo.messages.push(newMessage);

          this.debug("Running model...");
          const res = await this.openai.chat.completions.create({
            model: "gpt-4-1106-preview",
            messages: [
              { role: "system", content: SYSTEM_INSTRUCTIONS },
              ...convo.messages,
            ],
            tools: Object.entries(this.tools).map(([k, v]) => {
              const tool = {
                type: "function",
                function: {
                  name: k,
                  ...v,
                  fn: undefined,
                },
              };
              delete tool["function"]["fn"];
              return tool as ChatCompletionTool;
            }),
            temperature: 1.0,
          });

          let calledTools = false;
          for (const choice of res.choices) {
            insp(choice.message);

            convo.messages.push(choice.message);

            if (choice.message.tool_calls) {
              calledTools = true;

              for (const tool_call of choice.message.tool_calls) {
                const function_name = tool_call.function.name;
                const function_to_call = (this.tools as any)[function_name].fn;
                const function_args = JSON.parse(tool_call.function.arguments);
                const function_response = await function_to_call.apply(this, [
                  channel,
                  function_args,
                ]);

                /*await this.slack.client.chat.postMessage({
                  channel,
                  text: `\`${function_name}(${JSON.stringify(
                    function_args,
                  )})\``,
                });*/

                convo.messages.push({
                  tool_call_id: tool_call.id,
                  role: "tool",
                  content: "", // TODO: response value
                  //content: function_response,
                });
              }
            }
          }
        }
      }

      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  // Hooks //

  async onAdded(e: SlackEventMiddlewareArgs<"member_joined_channel">) {}

  async onRemoved(e: SlackEventMiddlewareArgs<"member_left_channel">) {
    this.info("I was kicked ;(");
  }

  async onMessage(e: SlackEventMiddlewareArgs<"message">) {
    if (e.message.subtype) return; // ignore non-messages (like deleted messages)

    this.debug("New message:", e.message);

    const chan = e.message.channel;
    if (!(chan in KV.convos)) {
      const newFileId = await this.startIncident(chan);
      KV.convos[chan] = {
        gdocId: newFileId!,
        messages: [],
        inbox: ["New channel"],
      };
      await this.slack.client.chat.postMessage({
        channel: chan,
        text: `Hi! I'll be keeping this report updated: https://docs.google.com/document/d/${newFileId!}`,
      });
      await this.toolUpdateTitle(chan, {
        title: "Untitled",
      });
      await this.toolUpdatePriority(chan, {
        priority: 5,
      });
    }
    const convo = KV.convos[chan];

    // ---

    const text = (e.message as any).text;
    const uid = (e.message as any).user;
    const user = await this.lookupUser(uid);

    convo.inbox.push(`${user.user?.real_name}: ${text}`);
  }

  async lookupUser(uid: string) {
    if (uid in KV.users) {
      return KV.users[uid];
    } else {
      this.debug("Fetching user info for", uid);
      return (KV.users[uid] = await this.slack.client.users.info({
        user: uid,
      }));
    }
  }

  async startIncident(channel: string) {
    // copy the template
    const file = await this.gdrive.files.copy({
      fileId: TEMPLATE_FILE_ID,
      requestBody: {
        name: "Incident Report",
        parents: [INCIDENT_FOLDER_ID],
      },
    });

    // get the Document object
    const doc = await this.gdocs.documents.get({
      documentId: file.data.id!,
    });

    // Create named ranges. (I know......)
    let updates: docs_v1.Schema$Request[] = [];
    for (const block of doc.data.body?.content || []) {
      for (const el of block.paragraph?.elements || []) {
        for (const [rangeKey, tpl] of Object.entries(TEMPLATE_INJECTIONS)) {
          const index = el.textRun?.content?.indexOf(tpl);
          if (typeof index === "number" && index !== -1) {
            const start = el.startIndex! + index;
            const end = start + tpl.length;
            updates.push({
              createNamedRange: {
                name: rangeKey,
                range: {
                  startIndex: start,
                  endIndex: end,
                },
              },
            });
          }
        }
      }
    }

    if (updates.length > 0) {
      await this.gdocs.documents.batchUpdate({
        documentId: doc.data.documentId!,
        requestBody: {
          requests: updates,
        },
      });
    }

    return doc.data.documentId;
  }

  // Tools //

  get tools() {
    return {
      ignore: {
        description:
          "Do nothing. Call this when nothing relevant happened since your last action.",
        parameters: { type: "object", properties: {} },
        fn: this.toolIgnore,
      },
      update_priority: {
        description:
          "Updates the incident priority. This function should be called on any relevant message, even if the priority is not changing.",
        parameters: {
          type: "object",
          properties: {
            priority: {
              type: "integer",
              description:
                "The priority level, where 0 is an absolute emergency (major service disruption) and 5 is very low (minimal impact)",
            },
          },
          required: ["priority"],
        },
        fn: this.toolUpdatePriority,
      },
      update_title: {
        description:
          "Updates the incident title. It should reflect the general impact/description of the incident, in few words. You can change it reasonably often.",
        parameters: {
          type: "object",
          properties: {
            title: {
              type: "string",
              description: "The new document title",
            },
          },
          required: ["title"],
        },
        fn: this.toolUpdateTitle,
      },
      append_external_status: {
        description:
          "Append a bullet item to a list of status updates. These are meant to be read by the company at large, including people not directly managing the incident and products in question, but possibly affected by it. They should be concise, but frequent (bot not frequent enough to add little or no information). For example, it would be updated when there's more info about availability and impact, but not when someone just jumped in to help.",
        parameters: TOOL_APPEND_PARAMS,
        fn: this.toolAppendExternalStatus,
      },
      append_internal_status: {
        description:
          "Append a bullet item to a list of internal (within the incident management team) status updates. These should be updated more frequently, when more information is uncovered, or when someone gets involved or starts following a certain path of investigation. They can be more detailed. For example, any numbers (% failures, error codes) shouldn't be dropped, and you can mention co-workers by name, as well as codenames and trade secrets.",
        parameters: TOOL_APPEND_PARAMS,
        fn: this.toolAppendInternalStatus,
      },
      append_remediations: {
        description:
          "Append a bullet item to a list of future/in-progress remediations, based on information from chat participants.",
        parameters: TOOL_APPEND_PARAMS,
        fn: this.toolAppendRemediations,
      },
      append_impact: {
        description:
          "Append a bullet item to a list of impacted services, based on the conversation. You should update this whenever there are new informations on impacted systems, platforms, products and users.",
        parameters: TOOL_APPEND_PARAMS,
        fn: this.toolAppendImpact,
      },
    };
  }

  async toolIgnore(channel: string, options: {}) {}

  async toolUpdateTitle(channel: string, options: { title: string }) {
    await this.gdrive.files.update({
      fileId: KV.convos[channel].gdocId,
      requestBody: {
        name: "Incident Report - " + options.title,
      },
    });
    await this.docRangeReplace(channel, "title", `${options.title}`);
  }

  async toolUpdatePriority(channel: string, options: { priority: number }) {
    await this.docRangeReplace(channel, "priority", `P${options.priority}`);
  }

  async toolAppendExternalStatus(channel: string, options: { text: string }) {
    await this.docListAppend(channel, "Status", options.text);
  }

  async toolAppendInternalStatus(channel: string, options: { text: string }) {
    await this.docListAppend(channel, "Status (Internal)", options.text);
  }

  async toolAppendRemediations(channel: string, options: { text: string }) {
    await this.docListAppend(channel, "Remediations", options.text);
  }

  async toolAppendImpact(channel: string, options: { text: string }) {
    await this.docListAppend(channel, "Impact", options.text);
  }

  async docListAppend(channel: string, header: string, text: string) {
    const convo = KV.convos[channel];
    if (!convo) return;

    const doc = await this.gdocs.documents.get({
      documentId: convo.gdocId,
    });

    let seekingListEnd = false;
    for (const block of doc.data.body?.content || []) {
      if (seekingListEnd && block.paragraph && !block.paragraph.bullet) {
        console.log("Found end:", block.endIndex);
        await this.gdocs.documents.batchUpdate({
          documentId: doc.data.documentId!,
          requestBody: {
            requests: [
              {
                insertText: {
                  text:
                    dayjs.utc().format("HH:mm:ss UTC") + " - " + text + "\n",
                  location: {
                    index: block.startIndex! - 1,
                  },
                },
              },
            ],
          },
        });
        break;
      }

      for (const el of block?.paragraph?.elements || []) {
        if (el?.textRun?.content === header + "\n") {
          seekingListEnd = true;
        }
      }
    }
  }

  async docRangeReplace(channel: string, rangeName: string, text: string) {
    const convo = KV.convos[channel];
    if (!convo) return;

    await this.gdocs.documents.batchUpdate({
      documentId: convo.gdocId,
      requestBody: {
        requests: [
          {
            replaceNamedRangeContent: {
              text: text,
              namedRangeName: rangeName,
            },
          },
        ],
      },
    });
  }

  // Logging //

  debug(...s: any[]) {
    console.debug("[dbg]", ...s);
  }

  info(...s: any[]) {
    console.info("[info]", ...s);
  }

  warn(...s: any[]) {
    console.warn("[warn]", ...s);
  }

  error(...s: any[]) {
    console.error("[err]", ...s);
  }

  critical(...s: any[]) {
    console.error("[critical]", ...s);
    throw new Error(`Critical error: ${s.join(" ")}`);
  }
}

async function main() {
  const bot = new IncidentBot();
  await bot.init();
}

function insp(obj: any) {
  console.log(
    util.inspect(obj, {
      depth: null,
      colors: true,
    }),
  );
}

main();
