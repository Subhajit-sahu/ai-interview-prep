import { NextResponse } from "next/server";
import { auth, db } from "@/firebase/admin";
import { getRandomInterviewCover } from "@/lib/utils";

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

/** Safe parse: try JSON.parse, otherwise find first JSON array substring and parse it. */
export function safeParseJsonArray(input: string): string[] {
  try {
    const parsed = JSON.parse(input);
    if (Array.isArray(parsed) && parsed.every((q) => typeof q === "string")) {
      return parsed;
    }
  } catch {
    // continue to fallback
  }

  // fallback: extract first JSON array-like substring
  const start = input.indexOf("[");
  const end = input.lastIndexOf("]");
  if (start !== -1 && end !== -1 && end > start) {
    try {
      const sub = input.slice(start, end + 1);
      const parsed = JSON.parse(sub);
      if (Array.isArray(parsed) && parsed.every((q) => typeof q === "string")) {
        return parsed;
      }
    } catch {
      // will throw below
    }
  }

  throw new Error("Unable to parse assistant output into JSON array of strings.");
}

interface AuthenticationResult {
  verifiedUserId?: string;
  error?: string;
  status?: number;
}

/**
 * Authenticates the request and securely resolves the candidate identity.
 * Security Rules:
 * 1. Never treat the mere presence/existence of a Firebase UID as authorization.
 * 2. If a cryptographic Firebase ID token is provided, verify it directly.
 * 3. Otherwise, the caller MUST authenticate using the trusted VAPI_WEBHOOK_SECRET.
 * 4. If VAPI_WEBHOOK_SECRET is unconfigured on the server and no verified token is provided,
 *    FAIL CLOSED immediately with HTTP 500.
 * 5. Verify the candidate identity exists in Firebase before associating the interview.
 */
async function authenticateAndResolveCandidate(
  request: Request,
  body: Record<string, unknown>
): Promise<AuthenticationResult> {
  const configuredWebhookSecret = process.env.VAPI_WEBHOOK_SECRET;

  // 1. Check for cryptographically verified candidate token
  const tokenCandidate =
    (typeof body.userToken === "string" && body.userToken) ||
    (typeof body.idToken === "string" && body.idToken) ||
    request.headers.get("x-user-token");

  if (tokenCandidate && tokenCandidate !== configuredWebhookSecret) {
    try {
      const decoded = await auth.verifyIdToken(tokenCandidate.trim());
      if (decoded?.uid) {
        return { verifiedUserId: decoded.uid };
      }
    } catch {
      return {
        error: "Unauthorized: Invalid or expired candidate verification token",
        status: 401,
      };
    }
  }

  // 2. If no valid cryptographic token is provided, require trusted webhook credentials
  if (!configuredWebhookSecret) {
    // FAIL CLOSED: Never silently accept unauthenticated requests when webhook secret is missing
    return {
      error: "Authentication configuration error: VAPI_WEBHOOK_SECRET is not configured on the server",
      status: 500,
    };
  }

  const customHeaderSecret = request.headers.get("x-vapi-secret");
  const authHeader = request.headers.get("authorization");
  const bearerSecret = authHeader?.startsWith("Bearer ")
    ? authHeader.slice(7).trim()
    : null;

  const isWebhookAuthenticated =
    customHeaderSecret === configuredWebhookSecret ||
    bearerSecret === configuredWebhookSecret;

  if (!isWebhookAuthenticated) {
    return {
      error: "Unauthorized: Invalid or missing webhook credentials",
      status: 401,
    };
  }

  // 3. Webhook caller is authenticated. Now extract and verify the candidate ID bound to the session
  const candidateId =
    (typeof body.userid === "string" && body.userid) ||
    (typeof body.userId === "string" && body.userId) ||
    request.headers.get("x-user-id");

  if (!candidateId || !candidateId.trim()) {
    return {
      error: "Validation failed: 'userid' is required to associate the interview with the candidate",
      status: 400,
    };
  }

  const cleanUserId = candidateId.trim();

  // 4. Verify candidate exists in Firebase Auth or Firestore
  try {
    let exists = false;
    try {
      const userRecord = await auth.getUser(cleanUserId);
      if (userRecord?.uid) exists = true;
    } catch {
      const userDoc = await db.collection("users").doc(cleanUserId).get();
      if (userDoc.exists) exists = true;
    }

    if (!exists) {
      return {
        error: "Forbidden: Candidate does not exist in the system",
        status: 403,
      };
    }

    return { verifiedUserId: cleanUserId };
  } catch {
    return {
      error: "Database error: Failed to verify candidate record",
      status: 500,
    };
  }
}

export async function POST(request: Request) {
  try {
    // 1. Parse request JSON body safely
    let body: Record<string, unknown>;
    try {
      body = (await request.json()) as Record<string, unknown>;
    } catch {
      return NextResponse.json(
        { success: false, error: "Invalid request payload: Expected valid JSON" },
        { status: 400 }
      );
    }

    // 2. Authenticate caller and securely resolve candidate identity (Fail-Closed)
    const authResult = await authenticateAndResolveCandidate(request, body);
    if (authResult.error || !authResult.verifiedUserId) {
      return NextResponse.json(
        { success: false, error: authResult.error },
        { status: authResult.status || 401 }
      );
    }
    const verifiedUserId = authResult.verifiedUserId;

    const { type, role, level, techstack, amount } = body;

    // 3. Validate interview preferences
    if (!role || typeof role !== "string" || !role.trim()) {
      return NextResponse.json(
        { success: false, error: "Validation failed: 'role' is required and must be a non-empty string" },
        { status: 400 }
      );
    }

    if (!type || typeof type !== "string" || !type.trim()) {
      return NextResponse.json(
        { success: false, error: "Validation failed: 'type' is required and must be a non-empty string" },
        { status: 400 }
      );
    }

    if (!level || typeof level !== "string" || !level.trim()) {
      return NextResponse.json(
        { success: false, error: "Validation failed: 'level' is required and must be a non-empty string" },
        { status: 400 }
      );
    }

    if (amount === undefined || amount === null) {
      return NextResponse.json(
        { success: false, error: "Validation failed: 'amount' is required" },
        { status: 400 }
      );
    }

    const questionAmount =
      typeof amount === "number" ? amount : parseInt(String(amount).trim(), 10);

    if (
      isNaN(questionAmount) ||
      !Number.isInteger(questionAmount) ||
      questionAmount < 1 ||
      questionAmount > 20
    ) {
      return NextResponse.json(
        { success: false, error: "Validation failed: 'amount' must be a positive integer between 1 and 20" },
        { status: 400 }
      );
    }

    // Normalize techstack (array or comma-delimited string)
    let normalizedTechstack: string[] = [];
    if (Array.isArray(techstack)) {
      normalizedTechstack = techstack
        .map((t) => String(t).trim())
        .filter(Boolean);
    } else if (typeof techstack === "string") {
      normalizedTechstack = techstack
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean);
    } else if (techstack !== undefined && techstack !== null) {
      return NextResponse.json(
        { success: false, error: "Validation failed: 'techstack' must be an array of strings or comma-separated string" },
        { status: 400 }
      );
    }

    // 4. Verify LLM configuration
    const openRouterApiKey = process.env.OPENROUTER_API_KEY;
    if (!openRouterApiKey) {
      return NextResponse.json(
        { success: false, error: "Service configuration error: OpenRouter API key is missing" },
        { status: 500 }
      );
    }
    const model = process.env.OPENROUTER_MODEL || "mistralai/devstral-2512:free";

    // 5. Compose strict prompt for OpenRouter
    const basePrompt = `
        Prepare questions for a job interview.
        The job role is ${role.trim()}.
        The job experience level is ${level.trim()}.
        The tech stack used in the job is: ${normalizedTechstack.join(", ")}.
        The focus between behavioural and technical questions should lean towards: ${type.trim()}.
        The amount of questions required is: ${questionAmount}.
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

    // 6. Call OpenRouter with reasoning enabled
    let firstData: {
      choices?: Array<{
        message?: {
          content?: string;
          reasoning_details?: unknown;
        };
      }>;
    };
    try {
      const firstResponse = await fetch(OPENROUTER_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${openRouterApiKey}`,
        },
        body: JSON.stringify({
          model,
          messages: [{ role: "user", content: basePrompt }],
          reasoning: { enabled: true },
          temperature: 0,
        }),
      });

      if (!firstResponse.ok) {
        return NextResponse.json(
          { success: false, error: "Failed to generate interview questions from AI service" },
          { status: 502 }
        );
      }

      firstData = (await firstResponse.json()) as typeof firstData;
    } catch {
      return NextResponse.json(
        { success: false, error: "AI service communication failure" },
        { status: 502 }
      );
    }

    if (!firstData?.choices?.[0]?.message) {
      return NextResponse.json(
        { success: false, error: "Invalid response from AI service (initial reasoning)" },
        { status: 502 }
      );
    }

    const assistantMsg = firstData.choices[0].message;

    // 7. Follow-up verification call preserving reasoning details
    const followUpMessages = [
      { role: "user", content: basePrompt },
      {
        role: "assistant",
        content: assistantMsg.content ?? "",
        ...(assistantMsg.reasoning_details ? { reasoning_details: assistantMsg.reasoning_details } : {}),
      },
      { role: "user", content: "Are you sure? Think carefully." },
    ];

    let secondData: {
      choices?: Array<{
        message?: {
          content?: string;
        };
      }>;
    };
    try {
      const secondResponse = await fetch(OPENROUTER_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${openRouterApiKey}`,
        },
        body: JSON.stringify({
          model,
          messages: followUpMessages,
          temperature: 0,
        }),
      });

      if (!secondResponse.ok) {
        return NextResponse.json(
          { success: false, error: "Failed to finalize interview questions from AI service" },
          { status: 502 }
        );
      }

      secondData = (await secondResponse.json()) as typeof secondData;
    } catch {
      return NextResponse.json(
        { success: false, error: "AI service communication failure during finalization" },
        { status: 502 }
      );
    }

    if (!secondData?.choices?.[0]?.message) {
      return NextResponse.json(
        { success: false, error: "Invalid response from AI service (final reasoning)" },
        { status: 502 }
      );
    }

    const finalContent = secondData.choices[0].message.content ?? assistantMsg.content ?? "[]";

    // 8. Parse and validate generated questions
    let questions: string[] = [];
    try {
      questions = safeParseJsonArray(finalContent);
    } catch {
      return NextResponse.json(
        { success: false, error: "Failed to parse interview questions format from AI output" },
        { status: 502 }
      );
    }

    // 9. Persist interview in Firestore associated strictly with verified candidate
    const interview = {
      role: role.trim(),
      type: type.trim(),
      level: level.trim(),
      techstack: normalizedTechstack,
      questions,
      userId: verifiedUserId,
      finalized: true,
      coverImage: getRandomInterviewCover(),
      createdAt: new Date().toISOString(),
    };

    let docRef;
    try {
      docRef = await db.collection("interviews").add(interview);
    } catch {
      return NextResponse.json(
        { success: false, error: "Database error: Failed to save interview" },
        { status: 500 }
      );
    }

    // 10. Return consistent, contract-aligned response
    return NextResponse.json(
      {
        success: true,
        interviewId: docRef.id,
        role: interview.role,
        type: interview.type,
        level: interview.level,
        amount: questionAmount,
        techstack: interview.techstack,
        questions: interview.questions,
      },
      { status: 200 }
    );
  } catch {
    return NextResponse.json(
      { success: false, error: "Internal server error" },
      { status: 500 }
    );
  }
}

export async function GET() {
  return NextResponse.json(
    { success: true, message: "PrepWise Vapi generation endpoint is healthy" },
    { status: 200 }
  );
}