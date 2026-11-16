// Vercel serverless entry: every /api/* request is rewritten here (see vercel.json). Static files come from public/.
export { handler as default } from "../server.mjs";

export const config = { maxDuration: 60 };
