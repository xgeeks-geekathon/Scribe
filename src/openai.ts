import OpenAI from "openai";

const API_KEY = "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";

export const getOpenAI = () =>
  new OpenAI({
    apiKey: API_KEY,
  });
