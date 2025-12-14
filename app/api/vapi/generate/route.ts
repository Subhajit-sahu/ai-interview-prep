
// app/api/generate-interview/route.ts (Next.js App Router style)
// or adapt to pages/api/generate-interview.ts
import { NextResponse } from "next/server"; // if using Next.js App Router; else use Response
import { db } from "@/firebase/admin";
import { getRandomInterviewCover } from "@/lib/utils";

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const MODEL = process.env.OPENROUTER_MODEL || "mistralai/devstral-2512:free";

if (!OPENROUTER_API_KEY) {
  throw new Error("Missing OPENROUTER_API_KEY in environment.");
}

/** Safe parse: try JSON.parse, otherwise find first JSON array substring and parse it. */
function safeParseJsonArray(input: string): string[] {
  try {
    const parsed = JSON.parse(input);
    if (Array.isArray(parsed)) return parsed;
  } catch (e) {
    // continue to fallback
  }

  // fallback: extract first JSON array-like substring
  const start = input.indexOf("[");
  const end = input.lastIndexOf("]");
  if (start !== -1 && end !== -1 && end > start) {
    try {
      const sub = input.slice(start, end + 1);
      const parsed = JSON.parse(sub);
      if (Array.isArray(parsed)) return parsed;
    } catch (e) {
      // will throw below
    }
  }

  throw new Error("Unable to parse assistant output into JSON array of strings.");
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { type, role, level, techstack, amount, userid } = body;

    if (!role || !amount || !userid) {
      return NextResponse.json({ success: false, error: "Missing required fields" }, { status: 400 });
    }

    // Compose strict prompt for the assistant to return a JSON array
    const basePrompt = `
        Prepare questions for a job interview.
        The job role is ${role}.
        The job experience level is ${level}.
        The tech stack used in the job is: ${techstack}.
        The focus between behavioural and technical questions should lean towards: ${type}.
        The amount of questions required is: ${amount}.
        STRICT RULES:
        1. Absolutely NO punctuation in any question
           This means no commas periods semicolons colons question marks slashes hyphens quotes or any special symbols
        2. Only alphabet letters and spaces are allowed
        3. Do NOT number the questions
        4. Do NOT add explanations
        5. Return ONLY a valid JSON array of plain text strings such as:
        ["Describe event loop in javascript", "Explain react state management"]

        Your entire response must be valid JSON with no trailing text.
        
        
        Thank you! <3
`;

    // -------- First API call with reasoning enabled --------
    const firstResponse = await fetch(OPENROUTER_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${OPENROUTER_API_KEY}`,
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [{ role: "user", content: basePrompt }],
        reasoning: { enabled: true },
        temperature: 0,
      }),
    });

    const firstData = await firstResponse.json();

    if (!firstData || !firstData.choices || !firstData.choices[0] || !firstData.choices[0].message) {
      return NextResponse.json({ success: false, error: "Invalid response from OpenRouter (first call)" }, { status: 500 });
    }

    // Extract assistant message and reasoning_details from first call
    const assistantMsg = firstData.choices[0].message as {
      content?: string;
      reasoning_details?: any;
    };

    // Build messages array preserving reasoning_details exactly as given
    const messages = [
      {
        role: "user",
        content: basePrompt,
      },
      {
        role: "assistant",
        content: assistantMsg.content ?? "",
        // Pass reasoning_details back verbatim if present
        ...(assistantMsg.reasoning_details ? { reasoning_details: assistantMsg.reasoning_details } : {}),
      },
      {
        role: "user",
        content: "Are you sure? Think carefully.",
      },
    ];

    // -------- Second API call: continue reasoning, get final answer --------
    const secondResponse = await fetch(OPENROUTER_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${OPENROUTER_API_KEY}`,
      },
      body: JSON.stringify({
        model: MODEL,
        messages,
        temperature: 0,
      }),
    });

    const secondData = await secondResponse.json();

    if (!secondData || !secondData.choices || !secondData.choices[0] || !secondData.choices[0].message) {
      return NextResponse.json({ success: false, error: "Invalid response from OpenRouter (second call)" }, { status: 500 });
    }

    const finalAssistantMsg = secondData.choices[0].message as { content?: string };

    const rawContent = finalAssistantMsg.content ?? "[]";

    // Parse JSON array (safe fallback)
    let questions: string[] = [];
    try {
      questions = safeParseJsonArray(rawContent);
      // Validate that items are strings
      if (!questions.every((q) => typeof q === "string")) {
        throw new Error("Parsed array items are not all strings.");
      }
    } catch (err) {
      return NextResponse.json({ success: false, error: `AI output parse error: ${(err as Error).message}`, aiOutput: rawContent }, { status: 500 });
    }

    // Prepare interview doc exactly like you used before
    const interview = {
      role,
      type,
      level,
      techstack: typeof techstack === "string" ? techstack.split(",") : Array.isArray(techstack) ? techstack : [],
      questions,
      userId: userid,
      finalized: true,
      coverImage: getRandomInterviewCover(),
      createdAt: new Date().toISOString(),
    };

    // Save to Firestore
    await db.collection("interviews").add(interview);

    return NextResponse.json({ success: true }, { status: 200 });
  } catch (err: any) {
    // Return full error message (no internal stack)
    const msg = err?.message ?? String(err);
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  }
}



/*

import { generateText } from "ai";
import { google } from "@ai-sdk/google";

import { db } from "@/firebase/admin";
import { getRandomInterviewCover } from "@/lib/utils";

export async function POST(request: Request) {
  const { type, role, level, techstack, amount, userid } = await request.json();

  try {
    const { text: questions } = await generateText({
      model: google("gemini-2.0-flash-001"),
      prompt: `Prepare questions for a job interview.
        The job role is ${role}.
        The job experience level is ${level}.
        The tech stack used in the job is: ${techstack}.
        The focus between behavioural and technical questions should lean towards: ${type}.
        The amount of questions required is: ${amount}.
        Please return only the questions, without any additional text.
        The questions are going to be read by a voice assistant so do not use "/" or "*" or any other special characters which might break the voice assistant.
        Return the questions formatted like this:
        ["Question 1", "Question 2", "Question 3"]
        
        Thank you! <3
    `,
    });

    const interview = {
      role: role,
      type: type,
      level: level,
      techstack: techstack.split(","),
      questions: JSON.parse(questions),
      userId: userid,
      finalized: true,
      coverImage: getRandomInterviewCover(),
      createdAt: new Date().toISOString(),
    };

    await db.collection("interviews").add(interview);

    return Response.json({ success: true }, { status: 200 });
  } catch (error) {
    console.error("Error:", error);
    return Response.json({ success: false, error: error }, { status: 500 });
  }
}

export async function GET() {
  return Response.json({ success: true, data: "Thank you!" }, { status: 200 });
}


*/