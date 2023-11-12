import OpenAI from "openai";

const API_KEY = process.env["SCRIBE_OPENAI_KEY"];

export const getOpenAI = () =>
  new OpenAI({
    apiKey: API_KEY,
  });
